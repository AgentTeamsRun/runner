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

const runObservedStart = async (): Promise<{
  migrations: number;
  pollingStarts: number;
  order: string[];
}> => {
  let migrations = 0;
  let pollingStarts = 0;
  const order: string[] = [];

  await runStartCommand({
    refreshExecutablePath: () => undefined,
    ensureCodexSandboxDefault: () => undefined,
    activatePreparedRestartHandoff: async () => false,
    writePidFile: async () => {
      order.push('pid-written');
    },
    removePidFile: async () => undefined,
    markDaemonReady: async () => {
      order.push('ready-marked');
    },
    migrateWindowsAutostartOnBoot: async () => {
      migrations += 1;
      order.push('autostart-migrated');
    },
    processOn: () => undefined,
    resolveRuntimeConfig: async () => runtimeConfig,
    startPolling: async () => {
      pollingStarts += 1;
      order.push('polling-started');
    },
    logger: { info: () => undefined },
  });

  return { migrations, pollingStarts, order };
};

test('runStartCommand preserves polling startup while checking the Windows autostart action', async () => {
  const observed = await runObservedStart();

  assert.equal(observed.migrations, 1);
  assert.equal(observed.pollingStarts, 1);
});

test('runStartCommand migrates a legacy Windows autostart action before polling', async () => {
  const observed = await runObservedStart();

  assert.equal(observed.migrations, 1);
  assert.equal(observed.pollingStarts, 1);
});

test('runStartCommand marks the instance ready only after its runtime config resolves', async () => {
  const observed = await runObservedStart();

  // A restart confirms the replacement from this stamp, so it must not appear
  // before the instance can actually do its job.
  assert.deepEqual(observed.order, ['pid-written', 'ready-marked', 'autostart-migrated', 'polling-started']);
});

test('runStartCommand stamps readiness before the Windows autostart re-registration', async () => {
  const observed = await runObservedStart();

  // The migration only changes what the *next* start uses, and its subprocess
  // round trip is slowest under exactly the CPU pressure a restart budgets for.
  // Keeping it out of the readiness window is what stops a healthy start from
  // being reported as [stage: not-ready].
  assert.ok(observed.order.indexOf('ready-marked') < observed.order.indexOf('autostart-migrated'));
});
