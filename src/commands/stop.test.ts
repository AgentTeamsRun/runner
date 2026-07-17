import assert from 'node:assert/strict';
import test from 'node:test';
import { runStopCommand } from './stop.js';

test('runStopCommand stops a registered Windows task daemon gracefully without ending the task action', async () => {
  const events: string[] = [];
  await runStopCommand({
    getDaemonStatus: async () => ({ running: true, pid: 4321 }),
    kill: (pid, signal) => {
      events.push(`kill:${pid}:${String(signal)}`);
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined, error: () => undefined },
  });

  assert.deepEqual(events, ['kill:4321:SIGTERM', 'pid-remove']);
});

test('runStopCommand preserves the manual stop path', async () => {
  const events: string[] = [];
  await runStopCommand({
    getDaemonStatus: async () => ({ running: true, pid: 99 }),
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined, error: () => undefined },
  });

  assert.deepEqual(events, ['kill', 'pid-remove']);
});
