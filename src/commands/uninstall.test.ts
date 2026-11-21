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
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: null, ready: true }),
    kill: () => assert.fail('the Windows path must never signal the runner directly'),
    stopWindowsDaemonInstance: async (pid) => {
      events.push(`stop:${pid}`);
      return { status: 'graceful', pid };
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    verifyRecordedDaemonInstance: async () => 'verified',
    logger: { info: () => undefined, warn: () => undefined },
  });

  assert.deepEqual(events, ['task-delete', 'stop:4321', 'pid-remove']);
});

test('runUninstallCommand preserves non-Windows stop-before-unregister order', async () => {
  const events: string[] = [];
  await runUninstallCommand({
    platform: () => 'linux',
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    unregisterAutostart: async () => {
      events.push('unregister');
    },
    getDaemonStatus: async () => ({ running: true, pid: 99, instanceId: null, ready: true }),
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    verifyRecordedDaemonInstance: async () => 'verified',
    logger: { info: () => undefined, warn: () => undefined },
  });

  assert.deepEqual(events, ['kill', 'pid-remove', 'unregister']);
});

test('runUninstallCommand does not signal a process that reused the recorded runner PID', async () => {
  const events: string[] = [];
  await runUninstallCommand({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    unregisterAutostart: async () => {
      events.push('task-delete');
    },
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: 'old', ready: true }),
    verifyRecordedDaemonInstance: async () => 'mismatch',
    kill: () => assert.fail('the Windows path must never signal the runner directly'),
    // 공용 경로가 신호 없이 기록만 버린다(daemon-stop.test.ts가 그 동작을 검증한다).
    stopWindowsDaemonInstance: async (pid) => ({ status: 'stale-record', pid }),
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined, warn: () => undefined },
  });

  assert.deepEqual(events, ['task-delete']);
});

test('runUninstallCommand keeps removing the service when the Windows runner could not be stopped', async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  await runUninstallCommand({
    platform: () => 'win32',
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    unregisterAutostart: async () => {
      events.push('task-delete');
    },
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: 'instance', ready: true }),
    stopWindowsDaemonInstance: async () => {
      throw new Error('could not be confirmed to be AgentRunner');
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
  });

  // 확인하지 못한 프로세스는 죽이지 않고, 살아 있을 수 있는 러너의 기록도 지우지 않는다.
  assert.deepEqual(events, ['task-delete']);
  assert.equal(warnings.length, 1);
});
