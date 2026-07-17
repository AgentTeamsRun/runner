import assert from 'node:assert/strict';
import test from 'node:test';
import { runUninstallCommand } from './uninstall.js';

test('runUninstallCommand deletes the Windows task before stopping the daemon process', async () => {
  const events: string[] = [];
  await runUninstallCommand({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    unregisterAutostart: async () => {
      events.push('task-delete');
    },
    getDaemonStatus: async () => ({ running: true, pid: 4321 }),
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, ['task-delete', 'kill', 'pid-remove']);
});

test('runUninstallCommand preserves non-Windows stop-before-unregister order', async () => {
  const events: string[] = [];
  await runUninstallCommand({
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    unregisterAutostart: async () => {
      events.push('unregister');
    },
    getDaemonStatus: async () => ({ running: true, pid: 99 }),
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, ['kill', 'pid-remove', 'unregister']);
});
