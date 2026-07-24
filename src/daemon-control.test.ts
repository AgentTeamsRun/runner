import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeRestartRequest,
  prepareDetachedRestartHandoff,
  restartDaemon,
  waitForDaemonToStart,
} from './daemon-control.js';

test('restartDaemon stops running daemon and restarts via autostart when registered', async () => {
  const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
  let statusChecks = 0;
  let restarted = false;

  await restartDaemon({
    getDaemonStatus: async () => {
      statusChecks += 1;
      if (statusChecks === 1) {
        return { running: true, pid: 4321 };
      }

      return { running: false, pid: null };
    },
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    restartAutostartService: async () => {
      restarted = true;
    },
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
    sleep: async () => undefined,
    logger: { info: () => undefined },
  });

  assert.deepEqual(signals, [{ pid: 4321, signal: 'SIGTERM' }]);
  assert.equal(restarted, true);
});

test('restartDaemon starts detached daemon when autostart is not registered', async () => {
  let started = false;

  await restartDaemon({
    getDaemonStatus: async () => ({ running: false, pid: null }),
    getAutostartStatus: () => ({ registered: false, platform: 'manual' }),
    restartAutostartService: async () => {
      throw new Error('should not restart autostart');
    },
    spawnDetachedDaemon: () => {
      started = true;
      return {
        unref: () => undefined,
      };
    },
    logger: { info: () => undefined },
  });

  assert.equal(started, true);
});

test('restartDaemon delegates Windows task restart without signaling the daemon first', async () => {
  const events: string[] = [];
  await restartDaemon({
    getDaemonStatus: async () => {
      events.push('status');
      return { running: true, pid: 4321 };
    },
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    restartAutostartService: async () => {
      events.push('task-restart');
    },
    kill: () => {
      events.push('kill');
      return true;
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, ['task-restart']);
});

test('waitForDaemonToStart returns once the runner reports running', async () => {
  let checks = 0;
  const sleeps: number[] = [];

  const status = await waitForDaemonToStart({
    getDaemonStatus: async () => {
      checks += 1;
      // Runner is still booting for the first two polls, then writes its PID.
      return checks < 3 ? { running: false, pid: null } : { running: true, pid: 999 };
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => 0,
  });

  assert.deepEqual(status, { running: true, pid: 999 });
  assert.equal(checks, 3);
  assert.equal(sleeps.length, 2);
});

test('waitForDaemonToStart gives up after the deadline and reports not running', async () => {
  let checks = 0;
  const now = [0, 5, 10, 20];
  let tick = 0;

  const status = await waitForDaemonToStart({
    getDaemonStatus: async () => {
      checks += 1;
      return { running: false, pid: null };
    },
    sleep: async () => undefined,
    now: () => now[Math.min(tick++, now.length - 1)] ?? 0,
    timeoutMs: 15,
  });

  assert.equal(status.running, false);
  // Stops polling once now() passes the deadline instead of looping forever.
  assert.ok(checks >= 1);
});

test('executeRestartRequest exits non-zero when supervised by launchd', async () => {
  const exitCodes: number[] = [];
  let spawned = false;

  await executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'launchd' }),
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'darwin',
    processExit: (code) => {
      exitCodes.push(code);
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(exitCodes, [1]);
  assert.equal(spawned, false);
});

test('executeRestartRequest exits non-zero when supervised by systemd', async () => {
  const exitCodes: number[] = [];
  let spawned = false;

  await executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'linux',
    processExit: (code) => {
      exitCodes.push(code);
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(exitCodes, [1]);
  assert.equal(spawned, false);
});

test('executeRestartRequest schedules an explicit restart and exits cleanly for Windows Task Scheduler', async () => {
  const exitCodes: number[] = [];
  let spawned = false;
  let scheduled = false;

  await executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    scheduleWindowsTaskRestart: async () => {
      scheduled = true;
      return {
        status: 'prepared',
        handoffId: 'windows-success',
        markerPath: '/tmp/restart-handoff-windows-success.json',
        replacementPid: 9002,
        replacementReady: true,
        acknowledged: false,
        retryableFailure: false,
      };
    },
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'win32',
    acknowledgePreparedHandoff: async () => true,
    processExit: (code) => {
      exitCodes.push(code);
    },
    logger: { info: () => undefined },
  });

  assert.equal(spawned, false);
  assert.equal(scheduled, true);
  assert.deepEqual(exitCodes, [0]);
});

test('executeRestartRequest keeps the daemon alive when the Windows restart helper fails to schedule', async () => {
  const exitCodes: number[] = [];

  await executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    // Helper creation failed — must NOT exit, or the runner dies with no replacement.
    scheduleWindowsTaskRestart: async () => ({
      status: 'retryable-failure',
      handoffId: 'windows-failure',
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'helper-preparation-failed',
      error: 'helper creation failed',
    }),
    platform: () => 'win32',
    processExit: (code) => {
      exitCodes.push(code);
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(exitCodes, [], 'daemon must not exit when the restart helper could not be created');
});

test('executeRestartRequest acks and exits only after a manual replacement is prepared', async () => {
  const events: string[] = [];

  await executeRestartRequest({
    getAutostartStatus: () => ({ registered: false, platform: 'launchd' }),
    prepareDetachedDaemon: async () => {
      events.push('prepared');
      return {
        status: 'prepared',
        handoffId: 'manual-success',
        markerPath: '/tmp/restart-handoff-manual-success.json',
        replacementPid: 9002,
        replacementReady: true,
        acknowledged: false,
        retryableFailure: false,
      };
    },
    acknowledgeRestart: async () => {
      events.push('ack');
    },
    acknowledgePreparedHandoff: async () => {
      events.push('commit');
      return true;
    },
    platform: () => 'darwin',
    processExit: (code) => {
      events.push(`exit:${code}`);
    },
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, ['prepared', 'ack', 'commit', 'exit:0']);
});

test('executeRestartRequest keeps the daemon alive when the prepared standby disappears during acknowledgement', async () => {
  const events: string[] = [];

  const result = await executeRestartRequest({
    getAutostartStatus: () => ({ registered: false, platform: 'manual' }),
    prepareDetachedDaemon: async () => ({
      status: 'prepared',
      handoffId: 'manual-disappeared',
      markerPath: '/tmp/restart-handoff-manual-disappeared.json',
      replacementPid: 9002,
      replacementReady: true,
      acknowledged: false,
      retryableFailure: false,
    }),
    acknowledgeRestart: async () => {
      events.push('ack');
    },
    acknowledgePreparedHandoff: async () => {
      events.push('commit-failed');
      return false;
    },
    processExit: (code) => {
      events.push(`exit:${code}`);
    },
    platform: () => 'darwin',
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, ['ack', 'commit-failed']);
  assert.equal(result.status, 'retryable-failure');
});

test('prepareDetachedRestartHandoff reports spawn failure without waiting for readiness', async () => {
  let waited = false;

  const result = await prepareDetachedRestartHandoff({
    handoffId: 'manual-spawn-failure',
    parentPid: 4321,
    markerPath: '/tmp/restart-handoff.json',
    unlink: async () => undefined,
    spawnDetachedDaemon: () => {
      throw new Error('spawn failed');
    },
    waitForPreparedRestartHandoff: async () => {
      waited = true;
      throw new Error('should not wait');
    },
  });

  assert.equal(result.status, 'retryable-failure');
  assert.equal(result.reason, 'replacement-preparation-failed');
  assert.equal(waited, false);
});

test('executeRestartRequest keeps supervised runners alive when acknowledgement fails', async () => {
  const exitCodes: number[] = [];

  const result = await executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    acknowledgeRestart: async () => {
      throw new Error('network down');
    },
    platform: () => 'linux',
    processExit: (code) => {
      exitCodes.push(code);
    },
    logger: { info: () => undefined },
  });

  assert.equal(result.status, 'retryable-failure');
  assert.equal(result.reason, 'acknowledgement-failed');
  assert.deepEqual(exitCodes, []);
});

test('executeRestartRequest preserves the current runner and request when the Windows helper reports a post-create failure', async () => {
  const events: string[] = [];

  const result = await executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    scheduleWindowsTaskRestart: async () => ({
      status: 'retryable-failure',
      handoffId: 'handoff-query-failure',
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'helper-preparation-failed',
      error: 'schtasks /Query failed with exit 1',
    }),
    acknowledgeRestart: async () => {
      events.push('ack');
    },
    spawnDetachedDaemon: () => {
      events.push('spawn');
    },
    processExit: (code) => {
      events.push(`exit:${code}`);
    },
    platform: () => 'win32',
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, [], 'a post-create helper failure must not ack or terminate the current runner');
  assert.equal(result.status, 'retryable-failure');
});

test('executeRestartRequest repairs a missing Windows scheduled task before preparing handoff', async () => {
  const events: string[] = [];

  const result = await executeRestartRequest({
    getAutostartStatus: () => ({ registered: false, platform: 'task-scheduler' }),
    registerWindowsTask: async () => {
      events.push('register');
      return { registered: true, servicePath: 'task.xml', platform: 'task-scheduler' };
    },
    scheduleWindowsTaskRestart: async () => {
      events.push('prepare');
      return {
        status: 'retryable-failure',
        handoffId: 'handoff-after-repair',
        replacementReady: false,
        acknowledged: false,
        retryableFailure: true,
        reason: 'helper-preparation-failed',
        error: 'replacement did not become ready',
      };
    },
    acknowledgeRestart: async () => {
      events.push('ack');
    },
    spawnDetachedDaemon: () => {
      events.push('spawn');
    },
    processExit: (code) => {
      events.push(`exit:${code}`);
    },
    platform: () => 'win32',
    config: { daemonToken: 'secret-token', apiUrl: 'https://api.example' },
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, ['register', 'prepare']);
  assert.equal(result.status, 'retryable-failure');
});

test('executeRestartRequest does not ack or exit when a manual replacement never becomes ready', async () => {
  const events: string[] = [];

  const result = await executeRestartRequest({
    getAutostartStatus: () => ({ registered: false, platform: 'manual' }),
    prepareDetachedDaemon: async () => ({
      status: 'retryable-failure',
      handoffId: 'manual-timeout',
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'replacement-preparation-failed',
      error: 'replacement readiness timed out',
    }),
    acknowledgeRestart: async () => {
      events.push('ack');
    },
    spawnDetachedDaemon: () => {
      events.push('spawn');
    },
    processExit: (code) => {
      events.push(`exit:${code}`);
    },
    platform: () => 'darwin',
    logger: { info: () => undefined },
  });

  assert.deepEqual(events, [], 'spawn success alone must not ack or terminate the current runner');
  assert.equal(result.status, 'retryable-failure');
});
