import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { platform as getPlatform } from 'node:os';
import {
  getAutostartStatus,
  launchWindowsHiddenDaemon,
  registerWindowsTask,
  restartAutostartService,
  scheduleWindowsTaskRestart,
} from './autostart.js';
import { logger } from './logger.js';
import { getDaemonStatus } from './pid.js';
import { spawnExecutable } from './executable.js';
import {
  acknowledgePreparedRestartHandoff,
  buildRestartHandoffEnv,
  getRestartHandoffPath,
  waitForPreparedRestartHandoff,
  type RestartExecutionResult,
  type RestartHandoffLaunch,
  type RestartHandoffPreparation,
} from './restart-handoff.js';
import { promises as fs } from 'node:fs';

type RunningDaemonStatus = {
  running: boolean;
  pid: number | null;
};

type DetachedChildProcess = {
  pid?: number;
  unref: () => void;
};

type RestartDeps = {
  getDaemonStatus?: () => Promise<RunningDaemonStatus>;
  getAutostartStatus?: typeof getAutostartStatus;
  restartAutostartService?: typeof restartAutostartService;
  spawnDetachedDaemon?: (launch?: RestartHandoffLaunch) => DetachedChildProcess | void;
  kill?: typeof process.kill;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<typeof logger, 'info'>;
};

type ExecuteRestartDeps = {
  getAutostartStatus?: typeof getAutostartStatus;
  scheduleWindowsTaskRestart?: typeof scheduleWindowsTaskRestart;
  registerWindowsTask?: typeof registerWindowsTask;
  prepareDetachedDaemon?: () => Promise<RestartHandoffPreparation>;
  spawnDetachedDaemon?: (launch?: RestartHandoffLaunch) => DetachedChildProcess | void;
  acknowledgeRestart?: () => Promise<void>;
  acknowledgePreparedHandoff?: typeof acknowledgePreparedRestartHandoff;
  config?: { daemonToken: string; apiUrl: string };
  platform?: typeof getPlatform;
  processExit?: (code: number) => void;
  logger?: Pick<typeof logger, 'info'>;
};

const restartPollIntervalMs = 100;
const stopTimeoutMs = 10_000;
const startTimeoutMs = 15_000;

type WaitForStartDeps = {
  getDaemonStatus?: () => Promise<RunningDaemonStatus>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

// A restart only *triggers* the replacement runner (a detached spawn, a
// Task Scheduler `/Run`, or a supervised respawn); the new process needs a
// moment to boot and write its PID file. Poll until it reports running so the
// command can report accurately instead of racing an async startup.
export const waitForDaemonToStart = async (deps: WaitForStartDeps = {}): Promise<RunningDaemonStatus> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedNow = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? startTimeoutMs;

  const deadline = resolvedNow() + timeoutMs;
  let status = await resolvedGetDaemonStatus();
  while (!status.running && resolvedNow() < deadline) {
    await resolvedSleep(restartPollIntervalMs);
    status = await resolvedGetDaemonStatus();
  }
  return status;
};

const waitForDaemonToStop = async (
  pid: number,
  deps: Required<Pick<RestartDeps, 'getDaemonStatus' | 'kill' | 'sleep'>>,
): Promise<void> => {
  deps.kill(pid, 'SIGTERM');

  const deadline = Date.now() + stopTimeoutMs;
  while (Date.now() < deadline) {
    await deps.sleep(restartPollIntervalMs);
    const status = await deps.getDaemonStatus();
    if (!status.running) {
      return;
    }
  }

  throw new Error(`Timed out waiting for AgentRunner process ${pid} to stop.`);
};

export const spawnDetachedDaemon = (launch?: RestartHandoffLaunch): DetachedChildProcess | void => {
  const env = launch ? buildRestartHandoffEnv(launch) : process.env;
  // On Windows, use the dedicated hidden PowerShell launcher so the `.cmd`
  // shim never creates a visible console host.
  if (getPlatform() === 'win32') {
    launchWindowsHiddenDaemon({ env });
    return;
  }

  const child = spawnExecutable('agentrunner', ['start'], {
    detached: true,
    stdio: 'ignore',
    env,
    cwd: process.cwd(),
  });
  child.unref();
  return child;
};

type PrepareDetachedRestartDeps = {
  spawnDetachedDaemon?: (launch: RestartHandoffLaunch) => DetachedChildProcess | void;
  waitForPreparedRestartHandoff?: typeof waitForPreparedRestartHandoff;
  unlink?: (path: string) => Promise<void>;
  handoffId?: string;
  parentPid?: number;
  markerPath?: string;
};

export const prepareDetachedRestartHandoff = async (
  deps: PrepareDetachedRestartDeps = {},
): Promise<RestartHandoffPreparation> => {
  const handoffId = deps.handoffId ?? randomUUID();
  const parentPid = deps.parentPid ?? process.pid;
  const markerPath = deps.markerPath ?? getRestartHandoffPath(handoffId);
  const launch = { handoffId, parentPid, markerPath };

  try {
    await (deps.unlink ?? fs.unlink)(markerPath);
  } catch {
    // Missing or stale marker is fine.
  }

  let child: DetachedChildProcess | void;
  try {
    child = (deps.spawnDetachedDaemon ?? spawnDetachedDaemon)(launch);
  } catch (error) {
    return {
      status: 'retryable-failure',
      handoffId,
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'replacement-preparation-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!child?.pid) {
    return {
      status: 'retryable-failure',
      handoffId,
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'replacement-preparation-failed',
      error: 'Replacement runner process did not expose a PID.',
    };
  }

  return (deps.waitForPreparedRestartHandoff ?? waitForPreparedRestartHandoff)(launch);
};

// Run from within the daemon itself when a web restart request is received.
// We can't call restartDaemon() here because that would SIGTERM our own PID
// before we get a chance to spawn the replacement; instead we either exit and
// let the OS supervisor restart us, or spawn a replacement and exit cleanly.
export const executeRestartRequest = async (deps: ExecuteRestartDeps = {}): Promise<RestartExecutionResult> => {
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedScheduleWindowsTaskRestart = deps.scheduleWindowsTaskRestart ?? scheduleWindowsTaskRestart;
  const resolvedRegisterWindowsTask = deps.registerWindowsTask ?? registerWindowsTask;
  const resolvedSpawnDetachedDaemon = deps.spawnDetachedDaemon ?? spawnDetachedDaemon;
  const acknowledgeRestart = deps.acknowledgeRestart ?? (async () => undefined);
  const acknowledgePreparedHandoff = deps.acknowledgePreparedHandoff ?? acknowledgePreparedRestartHandoff;
  const resolvedPlatform = (deps.platform ?? getPlatform)();
  const exitProcess = deps.processExit ?? ((code: number) => process.exit(code));
  const resolvedLogger = deps.logger ?? logger;

  let autostartStatus = resolvedGetAutostartStatus();
  if (resolvedPlatform === 'win32' || autostartStatus.platform === 'task-scheduler') {
    if (!autostartStatus.registered) {
      if (!deps.config) {
        return {
          status: 'retryable-failure',
          handoffId: randomUUID(),
          replacementReady: false,
          acknowledged: false,
          retryableFailure: true,
          reason: 'autostart-repair-failed',
          error: 'Windows Task Scheduler autostart is missing and runtime configuration is unavailable.',
        };
      }

      try {
        resolvedLogger.info('Windows Task Scheduler autostart is missing — repairing it before restart');
        await resolvedRegisterWindowsTask(
          { token: deps.config.daemonToken, apiUrl: deps.config.apiUrl },
          { startImmediately: false },
        );
        autostartStatus = { registered: true, platform: 'task-scheduler' };
      } catch (error) {
        return {
          status: 'retryable-failure',
          handoffId: randomUUID(),
          replacementReady: false,
          acknowledged: false,
          retryableFailure: true,
          reason: 'autostart-repair-failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    resolvedLogger.info('Restart requested — preparing an out-of-job Task Scheduler handoff');
    const preparation = await resolvedScheduleWindowsTaskRestart();
    if (preparation.status === 'retryable-failure') {
      resolvedLogger.info('Restart handoff preparation failed — keeping the current runner alive for retry');
      return preparation;
    }

    try {
      await acknowledgeRestart();
    } catch (error) {
      return {
        status: 'retryable-failure',
        handoffId: preparation.handoffId,
        replacementReady: false,
        acknowledged: false,
        retryableFailure: true,
        reason: 'acknowledgement-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!(await acknowledgePreparedHandoff(preparation))) {
      return {
        status: 'retryable-failure',
        handoffId: preparation.handoffId,
        replacementReady: false,
        acknowledged: false,
        retryableFailure: true,
        reason: 'replacement-confirmation-failed',
        error: 'The prepared Windows restart helper was no longer available after acknowledgement.',
      };
    }

    exitProcess(0);
    return {
      status: 'acknowledged',
      handoffId: preparation.handoffId,
      replacementReady: true,
      acknowledged: true,
      retryableFailure: false,
    };
  }
  const supervisedRespawn =
    autostartStatus.registered && (autostartStatus.platform === 'launchd' || autostartStatus.platform === 'systemd');

  if (supervisedRespawn) {
    const handoffId = randomUUID();
    try {
      await acknowledgeRestart();
    } catch (error) {
      return {
        status: 'retryable-failure',
        handoffId,
        replacementReady: false,
        acknowledged: false,
        retryableFailure: true,
        reason: 'acknowledgement-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    resolvedLogger.info('Restart requested — exiting non-zero so the OS supervisor restarts the daemon', {
      platform: autostartStatus.platform,
    });
    exitProcess(1);
    return {
      status: 'acknowledged',
      handoffId,
      replacementReady: true,
      acknowledged: true,
      retryableFailure: false,
    };
  }

  resolvedLogger.info('Restart requested — preparing a detached replacement runner', {
    platform: autostartStatus.platform,
    registered: autostartStatus.registered,
    osPlatform: resolvedPlatform,
  });
  const preparation = await (
    deps.prepareDetachedDaemon ??
    (() => prepareDetachedRestartHandoff({ spawnDetachedDaemon: resolvedSpawnDetachedDaemon }))
  )();
  if (preparation.status === 'retryable-failure') {
    return preparation;
  }

  try {
    await acknowledgeRestart();
  } catch (error) {
    return {
      status: 'retryable-failure',
      handoffId: preparation.handoffId,
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'acknowledgement-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!(await acknowledgePreparedHandoff(preparation))) {
    return {
      status: 'retryable-failure',
      handoffId: preparation.handoffId,
      replacementReady: false,
      acknowledged: false,
      retryableFailure: true,
      reason: 'replacement-confirmation-failed',
      error: 'The prepared replacement runner was no longer available after acknowledgement.',
    };
  }
  exitProcess(0);
  return {
    status: 'acknowledged',
    handoffId: preparation.handoffId,
    replacementReady: true,
    acknowledged: true,
    retryableFailure: false,
  };
};

export const restartDaemon = async (deps: RestartDeps = {}): Promise<void> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedRestartAutostartService = deps.restartAutostartService ?? restartAutostartService;
  const resolvedSpawnDetachedDaemon = deps.spawnDetachedDaemon ?? spawnDetachedDaemon;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedLogger = deps.logger ?? logger;

  const autostartStatus = resolvedGetAutostartStatus();
  if (autostartStatus.registered && autostartStatus.platform === 'task-scheduler') {
    resolvedLogger.info('Restarting AgentRunner via registered Task Scheduler task');
    await resolvedRestartAutostartService();
    return;
  }

  const daemonStatus = await resolvedGetDaemonStatus();
  if (daemonStatus.running && daemonStatus.pid !== null) {
    resolvedLogger.info('Stopping AgentRunner before restart', { pid: daemonStatus.pid });
    await waitForDaemonToStop(daemonStatus.pid, {
      getDaemonStatus: resolvedGetDaemonStatus,
      kill: resolvedKill,
      sleep: resolvedSleep,
    });
  }

  if (autostartStatus.registered) {
    resolvedLogger.info('Restarting AgentRunner via registered autostart service', {
      platform: autostartStatus.platform,
    });
    await resolvedRestartAutostartService();
    return;
  }

  resolvedLogger.info('Starting AgentRunner in background without autostart registration');
  resolvedSpawnDetachedDaemon();
};
