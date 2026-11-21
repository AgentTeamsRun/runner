import assert from 'node:assert/strict';
import test from 'node:test';
import { runStopCommand } from './stop.js';

test('runStopCommand stops a registered Windows task daemon gracefully without ending the task action', async () => {
  const events: string[] = [];
  await runStopCommand({
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: null, ready: true }),
    kill: (pid, signal) => {
      events.push(`kill:${pid}:${String(signal)}`);
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    verifyRecordedDaemonInstance: async () => 'verified',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  assert.deepEqual(events, ['kill:4321:SIGTERM', 'pid-remove']);
});

test('runStopCommand preserves the manual stop path', async () => {
  const events: string[] = [];
  await runStopCommand({
    getDaemonStatus: async () => ({ running: true, pid: 99, instanceId: null, ready: true }),
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    verifyRecordedDaemonInstance: async () => 'verified',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  assert.deepEqual(events, ['kill', 'pid-remove']);
});

test('runStopCommand does not signal a process that reused the recorded runner PID', async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  await runStopCommand({
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: 'old', ready: true }),
    verifyRecordedDaemonInstance: async () => 'mismatch',
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
  });

  assert.deepEqual(events, ['pid-remove']);
  assert.equal(warnings.length, 1);
});

test('runStopCommand still stops a runner whose identity cannot be verified', async () => {
  const events: string[] = [];
  await runStopCommand({
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: null, ready: true }),
    verifyRecordedDaemonInstance: async () => 'unverifiable',
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  assert.deepEqual(events, ['kill', 'pid-remove']);
});
