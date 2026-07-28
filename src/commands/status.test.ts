import assert from 'node:assert/strict';
import test from 'node:test';
import { runStatusCommand } from './status.js';

type LogEntry = {
  message: string;
  meta?: Record<string, unknown>;
};

const createLogger = () => {
  const infos: LogEntry[] = [];
  const warnings: LogEntry[] = [];
  return {
    infos,
    warnings,
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => infos.push({ message, meta }),
      warn: (message: string, meta?: Record<string, unknown>) => warnings.push({ message, meta }),
    },
  };
};

test('runStatusCommand reports a pending legacy Windows autostart migration', async () => {
  const observed = createLogger();

  await runStatusCommand({
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: true, pid: 4321 }),
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    windowsTaskNeedsNativeLauncherMigration: () => true,
    logger: observed.logger,
  });

  assert.deepEqual(observed.infos, [
    { message: 'Daemon is running', meta: { pid: 4321 } },
    { message: 'Autostart is enabled', meta: { platform: 'task-scheduler' } },
  ]);
  assert.equal(observed.warnings.length, 1);
  assert.match(observed.warnings[0]!.message, /next runner start/u);
  assert.match(observed.warnings[0]!.message, /agentrunner restart/u);
});

test('runStatusCommand stays quiet when the Windows task already uses the native launcher', async () => {
  const observed = createLogger();

  await runStatusCommand({
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: false, pid: null }),
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    windowsTaskNeedsNativeLauncherMigration: () => false,
    logger: observed.logger,
  });

  assert.equal(observed.warnings.length, 0);
});

test('runStatusCommand preserves non-Windows output without probing the Windows task', async () => {
  const observed = createLogger();
  let migrationChecks = 0;

  await runStatusCommand({
    platform: () => 'linux',
    getDaemonStatus: async () => ({ running: false, pid: null }),
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    windowsTaskNeedsNativeLauncherMigration: () => {
      migrationChecks += 1;
      return true;
    },
    logger: observed.logger,
  });

  assert.deepEqual(observed.infos, [
    { message: 'Daemon is not running', meta: undefined },
    { message: 'Autostart is enabled', meta: { platform: 'systemd' } },
  ]);
  assert.equal(observed.warnings.length, 0);
  assert.equal(migrationChecks, 0);
});
