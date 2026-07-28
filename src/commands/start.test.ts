import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeConfig } from '../types.js';
import { runStartCommand } from './start.js';

const runtimeConfig: RuntimeConfig = {
  daemonToken: 'daemon-token',
  apiUrl: 'https://api.example',
  pollingIntervalMs: 30_000,
  maxPollingIntervalMs: 120_000,
  timeoutMs: 86_400_000,
  idleTimeoutMs: 600_000,
  runnerCmd: 'codex',
  preventSleepWhileBusy: true,
};

const runObservedStart = async (): Promise<{ migrations: number; pollingStarts: number }> => {
  let migrations = 0;
  let pollingStarts = 0;

  await runStartCommand({
    refreshExecutablePath: () => undefined,
    ensureCodexSandboxDefault: () => undefined,
    activatePreparedRestartHandoff: async () => false,
    writePidFile: async () => undefined,
    removePidFile: async () => undefined,
    migrateWindowsAutostartOnBoot: async () => {
      migrations += 1;
    },
    processOn: () => undefined,
    resolveRuntimeConfig: async () => runtimeConfig,
    startPolling: async () => {
      pollingStarts += 1;
    },
    logger: { info: () => undefined },
  });

  return { migrations, pollingStarts };
};

test('runStartCommand preserves polling startup while checking the Windows autostart action', async () => {
  const observed = await runObservedStart();

  assert.deepEqual(observed, { migrations: 1, pollingStarts: 1 });
});

test('runStartCommand migrates a legacy Windows autostart action before polling', async () => {
  const observed = await runObservedStart();

  assert.deepEqual(observed, { migrations: 1, pollingStarts: 1 });
});
