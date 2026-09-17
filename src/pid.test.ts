import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDaemonStatus,
  isSameDaemonInstance,
  markDaemonReady,
  parseDaemonPidRecord,
  readPidFile,
  verifyRecordedDaemonInstance,
  writePidFile,
} from './pid.js';

const PID_FILE = '/tmp/agentrunner-test/daemon.pid';

const createFakePidFile = (initial: string | null = null) => {
  let content = initial;
  const chmodCalls: number[] = [];

  return {
    get content() {
      return content;
    },
    chmodCalls,
    deps: {
      pidFilePath: PID_FILE,
      mkdir: async () => undefined,
      readFile: async (path: string) => {
        assert.equal(path, PID_FILE);
        if (content === null) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return content;
      },
      writeFile: async (path: string, data: string) => {
        assert.equal(path, PID_FILE);
        content = data;
      },
      unlink: async () => {
        content = null;
      },
      chmodSync: (_path: string, mode: number) => {
        chmodCalls.push(mode);
      },
    },
  };
};

test('parseDaemonPidRecord accepts the legacy bare PID file', () => {
  assert.deepEqual(parseDaemonPidRecord('12600\n'), {
    pid: 12600,
    instanceId: null,
    startedAt: null,
    readyAt: null,
  });
});

test('parseDaemonPidRecord rejects content that is not a usable PID', () => {
  assert.equal(parseDaemonPidRecord(''), null);
  assert.equal(parseDaemonPidRecord('not-a-pid'), null);
  assert.equal(parseDaemonPidRecord('-1'), null);
  assert.equal(parseDaemonPidRecord('{'), null);
  assert.equal(parseDaemonPidRecord('{"instanceId":"a"}'), null);
});

test('writePidFile records an instance identity and restricts the file mode', async () => {
  const file = createFakePidFile();

  await writePidFile({ ...file.deps, processPid: 4321, instanceId: 'instance-a', now: () => new Date(0) });

  assert.deepEqual(JSON.parse(file.content!), {
    pid: 4321,
    instanceId: 'instance-a',
    startedAt: '1970-01-01T00:00:00.000Z',
    readyAt: null,
  });
  assert.deepEqual(file.chmodCalls, [0o600]);
  assert.equal(await readPidFile(file.deps), 4321);
});

test('a written but not-yet-ready instance is running and explicitly not ready', async () => {
  const file = createFakePidFile();
  await writePidFile({ ...file.deps, processPid: 4321, instanceId: 'instance-a' });

  assert.deepEqual(await getDaemonStatus({ ...file.deps, isProcessRunning: () => true }), {
    running: true,
    pid: 4321,
    instanceId: 'instance-a',
    ready: false,
  });
});

test('markDaemonReady flips the instance to ready while preserving its identity', async () => {
  const file = createFakePidFile();
  await writePidFile({ ...file.deps, processPid: 4321, instanceId: 'instance-a', now: () => new Date(0) });

  await markDaemonReady({ ...file.deps, processPid: 4321 });

  const record = JSON.parse(file.content!);
  assert.equal(record.instanceId, 'instance-a');
  assert.equal(record.startedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(typeof record.readyAt, 'string');
  assert.deepEqual(await getDaemonStatus({ ...file.deps, isProcessRunning: () => true }), {
    running: true,
    pid: 4321,
    instanceId: 'instance-a',
    ready: true,
  });
});

test('markDaemonReady never overwrites a record owned by another instance', async () => {
  const file = createFakePidFile(JSON.stringify({ pid: 999, instanceId: 'other', startedAt: 'x', readyAt: null }));

  await markDaemonReady({ ...file.deps, processPid: 4321 });

  assert.deepEqual(JSON.parse(file.content!), { pid: 999, instanceId: 'other', startedAt: 'x', readyAt: null });
});

test('a legacy PID file is reported as ready because it cannot express readiness', async () => {
  const file = createFakePidFile('12600');

  assert.deepEqual(await getDaemonStatus({ ...file.deps, isProcessRunning: () => true }), {
    running: true,
    pid: 12600,
    instanceId: null,
    ready: true,
  });
});

test('a stale PID file is cleared instead of reported as running', async () => {
  const file = createFakePidFile('12600');

  assert.deepEqual(await getDaemonStatus({ ...file.deps, isProcessRunning: () => false }), {
    running: false,
    pid: null,
    instanceId: null,
    ready: false,
  });
  assert.equal(file.content, null);
});

test('isSameDaemonInstance compares identity first and falls back to the PID', () => {
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: 'a' }, { pid: 1, instanceId: 'a' }), true);
  // Windows reuses PIDs: the same number with a new identity is a new instance.
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: 'a' }, { pid: 1, instanceId: 'b' }), false);
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: 'a' }, { pid: 2, instanceId: 'a' }), true);
  // Exactly one side predates instance identity: a legacy runner could not have
  // written that id, so the PID they share was reused by a replacement.
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: null }, { pid: 1, instanceId: 'b' }), false);
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: 'a' }, { pid: 1, instanceId: null }), false);
  // Both predate instance identity — the PID is all there is to compare.
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: null }, { pid: 1, instanceId: null }), true);
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: null }, { pid: 2, instanceId: null }), false);
  assert.equal(isSameDaemonInstance(null, { pid: 1, instanceId: 'a' }), false);
  assert.equal(isSameDaemonInstance({ pid: 1, instanceId: 'a' }, null), false);
});

test('verifyRecordedDaemonInstance rejects a PID that a later process inherited', async () => {
  const file = createFakePidFile();
  await writePidFile({ ...file.deps, processPid: 12600, instanceId: 'instance-a', now: () => new Date(1_000_000) });

  // A hard crash left the record behind and another process inherited the PID:
  // that process can only have started after the record was written.
  assert.equal(
    await verifyRecordedDaemonInstance(12600, {
      ...file.deps,
      readProcessStartTime: () => new Date(1_000_000 + 10 * 60_000),
    }),
    'mismatch',
  );
});

test('verifyRecordedDaemonInstance accepts the process that wrote the record', async () => {
  const file = createFakePidFile();
  await writePidFile({ ...file.deps, processPid: 12600, instanceId: 'instance-a', now: () => new Date(1_000_000) });

  assert.equal(
    await verifyRecordedDaemonInstance(12600, {
      ...file.deps,
      // The process started before it wrote its own PID file.
      readProcessStartTime: () => new Date(1_000_000 - 2_000),
    }),
    'verified',
  );
});

test('verifyRecordedDaemonInstance stays unverifiable when it cannot prove a mismatch', async () => {
  const file = createFakePidFile();
  await writePidFile({ ...file.deps, processPid: 12600, instanceId: 'instance-a', now: () => new Date(1_000_000) });

  // A platform whose start time cannot be read must behave as it did before.
  assert.equal(
    await verifyRecordedDaemonInstance(12600, { ...file.deps, readProcessStartTime: () => null }),
    'unverifiable',
  );
  // A different PID and a legacy bare-PID record are equally unprovable.
  assert.equal(
    await verifyRecordedDaemonInstance(23100, { ...file.deps, readProcessStartTime: () => new Date(0) }),
    'unverifiable',
  );

  const legacy = createFakePidFile('12600\n');
  assert.equal(
    await verifyRecordedDaemonInstance(12600, { ...legacy.deps, readProcessStartTime: () => new Date(0) }),
    'unverifiable',
  );
});
