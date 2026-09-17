import assert from 'node:assert/strict';
import test from 'node:test';
import { runRestartCommand } from './restart.js';

test('runRestartCommand resolves and logs the pid once a replacement reports ready', async () => {
  const infos: Array<{ message: string; meta?: unknown }> = [];
  let restarted = false;

  await runRestartCommand({
    restartDaemon: async () => {
      restarted = true;
      return { previousInstance: { pid: 1000, instanceId: 'before' } };
    },
    waitForDaemonToStart: async () => ({
      running: true,
      pid: 4321,
      instanceId: 'after',
      replaced: true,
      stage: 'replaced',
    }),
    logger: {
      info: (message: string, meta?: unknown) => {
        infos.push({ message, meta });
      },
      warn: () => undefined,
    },
  });

  assert.equal(restarted, true);
  assert.equal(infos.length, 1);
  assert.match(infos[0]!.message, /restart completed/u);
  assert.deepEqual(infos[0]!.meta, { pid: 4321, previousPid: 1000 });
});

test('runRestartCommand throws (non-zero exit) when the runner never reports running', async () => {
  await assert.rejects(
    runRestartCommand({
      restartDaemon: async () => ({ previousInstance: null }),
      // Confirmation timed out — runner did not come up.
      waitForDaemonToStart: async () => ({
        running: false,
        pid: null,
        instanceId: null,
        replaced: false,
        stage: 'not-running',
      }),
      logger: { info: () => undefined, warn: () => undefined },
    }),
    /no runner reported running within the timeout/u,
  );
});

test('runRestartCommand retries once after stopping a surviving pre-restart instance', async () => {
  const stopped: number[] = [];
  const stages: string[] = [];

  await runRestartCommand({
    restartDaemon: async () => ({ previousInstance: { pid: 12600, instanceId: 'before' } }),
    waitForDaemonToStart: async () => {
      stages.push('wait');
      return stopped.length === 0
        ? { running: true, pid: 12600, instanceId: 'before', replaced: false, stage: 'stale-instance' }
        : { running: true, pid: 23100, instanceId: 'after', replaced: true, stage: 'replaced' };
    },
    terminateDaemonInstance: async (instance) => {
      stopped.push(instance.pid);
    },
    logger: { info: () => undefined, warn: () => undefined },
  });

  assert.deepEqual(stopped, [12600]);
  assert.deepEqual(stages, ['wait', 'wait']);
});
