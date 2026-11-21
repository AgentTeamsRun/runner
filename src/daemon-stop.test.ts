import assert from 'node:assert/strict';
import test from 'node:test';
import { stopWindowsDaemonInstance, type StopWindowsDaemonDeps } from './daemon-stop.js';
import type { DaemonPidRecord } from './pid.js';
import type { ShutdownRequestOutcome } from './shutdown-channel.js';

const PID = 4321;

const recordWithChannel: DaemonPidRecord = {
  pid: PID,
  instanceId: 'instance-a',
  startedAt: '2026-11-21T00:00:00.000Z',
  readyAt: '2026-11-21T00:00:01.000Z',
  controlToken: 'token-a',
};

type Scenario = {
  record?: DaemonPidRecord | null;
  verification?: 'verified' | 'unverifiable' | 'mismatch';
  requestOutcome?: ShutdownRequestOutcome;
  /** 요청이 승인된 뒤 러너가 스스로 끝나는지. */
  exitsAfterRequest?: boolean;
  /** 강제 종료가 실제로 프로세스를 끝내는지. */
  diesWhenKilled?: boolean;
  confirmedByCommandLine?: boolean;
  alive?: boolean;
  force?: boolean;
};

const run = async (scenario: Scenario) => {
  const events: string[] = [];
  const warnings: string[] = [];
  let alive = scenario.alive ?? true;
  let clock = 0;

  const deps: StopWindowsDaemonDeps = {
    force: scenario.force,
    gracefulTimeoutMs: 1_000,
    forceTimeoutMs: 1_000,
    readDaemonPidRecord: async () => (scenario.record === undefined ? recordWithChannel : scenario.record),
    verifyRecordedDaemonInstance: async () => scenario.verification ?? 'verified',
    requestShutdown: async (target) => {
      events.push(`request:${target.pid}:${target.instanceId}:${target.controlToken}`);
      const outcome = scenario.requestOutcome ?? 'accepted';
      if (outcome === 'accepted' && (scenario.exitsAfterRequest ?? true)) alive = false;
      return outcome;
    },
    isProcessRunning: () => alive,
    isAgentRunnerProcess: () => {
      events.push('confirm-command-line');
      return scenario.confirmedByCommandLine ?? false;
    },
    killProcessTree: (pid) => {
      events.push(`kill-tree:${pid}`);
      if (scenario.diesWhenKilled ?? true) alive = false;
    },
    removePidFile: async () => {
      events.push('discard-record');
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    logger: { warn: (message) => warnings.push(message) },
  };

  let outcome: Awaited<ReturnType<typeof stopWindowsDaemonInstance>> | null = null;
  let error: Error | null = null;
  try {
    outcome = await stopWindowsDaemonInstance(PID, deps);
  } catch (caught) {
    error = caught as Error;
  }
  return { outcome, error, events, warnings };
};

test('a runner with a shutdown channel is asked to stop and is never killed when it complies', async () => {
  const { outcome, events, warnings } = await run({});

  assert.deepEqual(outcome, { status: 'graceful', pid: PID });
  assert.deepEqual(events, ['request:4321:instance-a:token-a']);
  assert.deepEqual(warnings, []);
});

test('a PID that now belongs to an unrelated process is neither asked nor killed; only the record is discarded', async () => {
  const { outcome, events } = await run({ verification: 'mismatch' });

  assert.deepEqual(outcome, { status: 'stale-record', pid: PID });
  assert.deepEqual(events, ['discard-record']);
});

test('a runner that already exited is reported as such without any request', async () => {
  const { outcome, events } = await run({ alive: false });

  assert.deepEqual(outcome, { status: 'already-exited', pid: PID });
  assert.deepEqual(events, []);
});

test('a runner that predates the shutdown channel is terminated as a tree, and that is reported as forced', async () => {
  const legacyRecord: DaemonPidRecord = { ...recordWithChannel, controlToken: null };
  const { outcome, events, warnings } = await run({ record: legacyRecord });

  assert.deepEqual(outcome, { status: 'forced', pid: PID, reason: 'no-channel' });
  assert.deepEqual(events, ['kill-tree:4321']);
  // 진행 중이던 실행이 취소로 보고되지 않았다는 사실을 조용히 넘기지 않는다.
  assert.equal(warnings.length, 1);
});

test('the token of a replacement instance is never sent to the pre-restart PID', async () => {
  // PID 기록은 이미 교체 러너의 것이다. 그 토큰으로 이전 PID의 채널에 요청하면 안 된다.
  const replacementRecord: DaemonPidRecord = { ...recordWithChannel, pid: 9999, instanceId: 'instance-b' };
  const { outcome, events } = await run({ record: replacementRecord });

  assert.deepEqual(outcome, { status: 'forced', pid: PID, reason: 'no-channel' });
  assert.deepEqual(events, ['kill-tree:4321']);
});

for (const requestOutcome of ['unavailable', 'rejected', 'timeout'] as const) {
  test(`a ${requestOutcome} shutdown request falls back to terminating the verified runner`, async () => {
    const { outcome, events } = await run({ requestOutcome });

    assert.deepEqual(outcome, { status: 'forced', pid: PID, reason: requestOutcome });
    assert.deepEqual(events, ['request:4321:instance-a:token-a', 'kill-tree:4321']);
  });
}

test('a runner that accepts the request but does not exit in time is terminated', async () => {
  const { outcome, events } = await run({ exitsAfterRequest: false });

  assert.deepEqual(outcome, { status: 'forced', pid: PID, reason: 'graceful-timeout' });
  assert.deepEqual(events, ['request:4321:instance-a:token-a', 'kill-tree:4321']);
});

test('an unverifiable PID is terminated only when its command line confirms it is AgentRunner', async () => {
  const legacyRecord: DaemonPidRecord = {
    pid: PID,
    instanceId: null,
    startedAt: null,
    readyAt: null,
    controlToken: null,
  };

  const confirmed = await run({ record: legacyRecord, verification: 'unverifiable', confirmedByCommandLine: true });
  assert.deepEqual(confirmed.outcome, { status: 'forced', pid: PID, reason: 'no-channel' });
  assert.deepEqual(confirmed.events, ['confirm-command-line', 'kill-tree:4321']);

  const unconfirmed = await run({ record: legacyRecord, verification: 'unverifiable', confirmedByCommandLine: false });
  assert.equal(unconfirmed.outcome, null);
  assert.match(unconfirmed.error?.message ?? '', /could not be confirmed to be AgentRunner, so it was not terminated/);
  assert.deepEqual(unconfirmed.events, ['confirm-command-line'], 'an unconfirmed PID must never be killed');
});

test('a runner that survives termination is reported as a failure, not as stopped', async () => {
  const { outcome, error, events } = await run({ requestOutcome: 'unavailable', diesWhenKilled: false });

  assert.equal(outcome, null);
  assert.match(error?.message ?? '', /Timed out waiting for AgentRunner process 4321 to stop/);
  assert.deepEqual(events, ['request:4321:instance-a:token-a', 'kill-tree:4321']);
});

test('with force disabled nothing is killed when the graceful stop does not happen', async () => {
  const { outcome, events } = await run({ requestOutcome: 'unavailable', force: false });

  assert.deepEqual(outcome, { status: 'not-stopped', pid: PID, reason: 'unavailable' });
  assert.deepEqual(events, ['request:4321:instance-a:token-a']);
});

test('a request that fails because the runner just exited is not followed by a kill', async () => {
  let alive = true;
  const events: string[] = [];
  const outcome = await stopWindowsDaemonInstance(PID, {
    readDaemonPidRecord: async () => recordWithChannel,
    verifyRecordedDaemonInstance: async () => 'verified',
    requestShutdown: async () => {
      alive = false;
      return 'unavailable';
    },
    isProcessRunning: () => alive,
    killProcessTree: () => {
      events.push('kill-tree');
    },
    logger: { warn: () => undefined },
  });

  assert.deepEqual(outcome, { status: 'already-exited', pid: PID });
  assert.deepEqual(events, []);
});
