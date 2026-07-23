import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRestartRequest, restartDaemon, waitForDaemonToStart } from './daemon-control.js';

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

test('executeRestartRequest exits non-zero when supervised by launchd', () => {
  const exitCodes: number[] = [];
  let spawned = false;

  executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'launchd' }),
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'darwin',
    processExit: ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as (code: number) => never,
    logger: { info: () => undefined },
  });

  assert.deepEqual(exitCodes, [1]);
  assert.equal(spawned, false);
});

test('executeRestartRequest exits non-zero when supervised by systemd', () => {
  const exitCodes: number[] = [];
  let spawned = false;

  executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'systemd' }),
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'linux',
    processExit: ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as (code: number) => never,
    logger: { info: () => undefined },
  });

  assert.deepEqual(exitCodes, [1]);
  assert.equal(spawned, false);
});

test('executeRestartRequest schedules an explicit restart and exits cleanly for Windows Task Scheduler', () => {
  const exitCodes: number[] = [];
  let spawned = false;
  let scheduled = false;

  executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    scheduleWindowsTaskRestart: () => {
      scheduled = true;
      return true;
    },
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'win32',
    processExit: ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as (code: number) => never,
    logger: { info: () => undefined },
  });

  assert.equal(spawned, false);
  assert.equal(scheduled, true);
  assert.deepEqual(exitCodes, [0]);
});

test('executeRestartRequest keeps the daemon alive when the Windows restart helper fails to schedule', () => {
  const exitCodes: number[] = [];

  executeRestartRequest({
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    // Helper creation failed — must NOT exit, or the runner dies with no replacement.
    scheduleWindowsTaskRestart: () => false,
    platform: () => 'win32',
    processExit: ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as (code: number) => never,
    logger: { info: () => undefined },
  });

  assert.deepEqual(exitCodes, [], 'daemon must not exit when the restart helper could not be created');
});

test('executeRestartRequest spawns a detached daemon when running manually on macOS', () => {
  const exitCodes: number[] = [];
  let spawned = false;

  executeRestartRequest({
    getAutostartStatus: () => ({ registered: false, platform: 'launchd' }),
    spawnDetachedDaemon: () => {
      spawned = true;
    },
    platform: () => 'darwin',
    processExit: ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as (code: number) => never,
    logger: { info: () => undefined },
  });

  assert.equal(spawned, true);
  assert.deepEqual(exitCodes, [0]);
});
