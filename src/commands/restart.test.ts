import assert from 'node:assert/strict';
import test from 'node:test';
import { runRestartCommand } from './restart.js';

test('runRestartCommand resolves and logs the pid once the runner reports running', async () => {
  const infos: Array<{ message: string; meta?: unknown }> = [];
  let restarted = false;

  await runRestartCommand({
    restartDaemon: async () => {
      restarted = true;
    },
    waitForDaemonToStart: async () => ({ running: true, pid: 4321 }),
    logger: {
      info: (message: string, meta?: unknown) => {
        infos.push({ message, meta });
      },
    },
  });

  assert.equal(restarted, true);
  assert.equal(infos.length, 1);
  assert.match(infos[0]!.message, /restart completed/u);
  assert.deepEqual(infos[0]!.meta, { pid: 4321 });
});

test('runRestartCommand throws (non-zero exit) when the runner never reports running', async () => {
  await assert.rejects(
    runRestartCommand({
      restartDaemon: async () => undefined,
      // Confirmation timed out — runner did not come up.
      waitForDaemonToStart: async () => ({ running: false, pid: null }),
      logger: { info: () => undefined },
    }),
    /did not report running within the timeout/u,
  );
});
