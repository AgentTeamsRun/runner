import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { platform as getPlatform } from 'node:os';
import {
  getAutostartStatus,
  getWindowsTaskMigrationReason,
  launchWindowsHiddenDaemon,
  registerWindowsTask,
  restartAutostartService,
  scheduleWindowsTaskRestart,
  WINDOWS_TASK_MIGRATION_DESCRIPTIONS,
} from './autostart.js';
import { logger } from './logger.js';
import {
  getDaemonStatus,
  isProcessRunning,
  isSameDaemonInstance,
  removePidFile,
  verifyRecordedDaemonInstance,
  type DaemonInstanceRef,
  type DaemonStatus,
  type RecordedInstanceVerification,
} from './pid.js';
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

type RunningDaemonStatus = DaemonStatus;

/**
 * Why a restart confirmation succeeded or failed. `stale-instance` is the case
 * that used to be reported as success: the restart was triggered, nothing
 * replaced the old runner, and the pre-restart PID was still alive to answer.
 */
export type DaemonStartStage = 'replaced' | 'stale-instance' | 'not-ready' | 'not-running';

export type DaemonStartConfirmation = {
  running: boolean;
  pid: number | null;
  instanceId: string | null;
  replaced: boolean;
  stage: DaemonStartStage;
};

export type RestartOutcome = {
  /** The instance observed before the restart was triggered, if any. */
  previousInstance: DaemonInstanceRef | null;
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
  getWindowsTaskMigrationReason?: typeof getWindowsTaskMigrationReason;
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
  /**
   * The instance that was running before the restart was triggered. The wait
   * only completes when a *different* instance reports ready; leaving it unset
   * means "any ready instance will do" (a plain start, not a replacement).
   */
  previousInstance?: DaemonInstanceRef | null;
};

const toInstanceRef = (status: RunningDaemonStatus): DaemonInstanceRef | null =>
  status.running && status.pid !== null ? { pid: status.pid, instanceId: status.instanceId } : null;

const describeStartStage = (
  status: RunningDaemonStatus,
  previousInstance: DaemonInstanceRef | null,
): DaemonStartStage => {
  const observed = toInstanceRef(status);
  if (!observed) {
    return 'not-running';
  }
  if (isSameDaemonInstance(observed, previousInstance)) {
    return 'stale-instance';
  }
  return status.ready ? 'replaced' : 'not-ready';
};

// A restart only *triggers* the replacement runner (a detached spawn, a
// Task Scheduler `/Run`, or a supervised respawn); the new process needs a
// moment to boot and write its PID file. Poll until it reports running so the
// command can report accurately instead of racing an async startup.
export const waitForDaemonToStart = async (deps: WaitForStartDeps = {}): Promise<DaemonStartConfirmation> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedNow = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? startTimeoutMs;
  const previousInstance = deps.previousInstance ?? null;

  const deadline = resolvedNow() + timeoutMs;
  let status = await resolvedGetDaemonStatus();
  let stage = describeStartStage(status, previousInstance);
  while (stage !== 'replaced' && resolvedNow() < deadline) {
    await resolvedSleep(restartPollIntervalMs);
    status = await resolvedGetDaemonStatus();
    stage = describeStartStage(status, previousInstance);
  }

  return {
    running: status.running,
    pid: status.pid,
    instanceId: status.instanceId,
    replaced: stage === 'replaced',
    stage,
  };
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

type TerminateInstanceDeps = {
  kill?: typeof process.kill;
  isProcessRunning?: (pid: number) => boolean;
  verifyRecordedDaemonInstance?: (pid: number) => Promise<RecordedInstanceVerification>;
  removePidFile?: () => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  logger?: Pick<typeof logger, 'warn'>;
};

/**
 * Terminate one specific recorded instance. Identity-based on purpose: a restart
 * must never kill "whatever looks like a runner", only the instance this
 * installation wrote into its own PID file. A runner that died without cleaning
 * up leaves that file behind, so the PID is confirmed to still belong to the
 * recorded instance before any signal is sent. The wait watches that PID
 * directly rather than the PID file, because a replacement may already own it.
 */
export const terminateDaemonInstance = async (
  instance: DaemonInstanceRef,
  deps: TerminateInstanceDeps = {},
): Promise<void> => {
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedIsProcessRunning = deps.isProcessRunning ?? isProcessRunning;
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedNow = deps.now ?? (() => Date.now());
  const resolvedVerify = deps.verifyRecordedDaemonInstance ?? ((pid: number) => verifyRecordedDaemonInstance(pid));
  const resolvedRemovePidFile = deps.removePidFile ?? (() => removePidFile());
  const resolvedLogger = deps.logger ?? logger;

  if ((await resolvedVerify(instance.pid)) === 'mismatch') {
    resolvedLogger.warn(
      'The recorded AgentRunner PID now belongs to an unrelated process — discarding the stale record',
      {
        pid: instance.pid,
      },
    );
    await resolvedRemovePidFile();
    return;
  }

  try {
    resolvedKill(instance.pid, 'SIGTERM');
  } catch {
    // Already gone between the observation and the signal — nothing to stop.
    return;
  }

  const deadline = resolvedNow() + (deps.timeoutMs ?? stopTimeoutMs);
  while (resolvedNow() < deadline) {
    if (!resolvedIsProcessRunning(instance.pid)) {
      return;
    }
    await resolvedSleep(restartPollIntervalMs);
  }

  throw new Error(`Timed out waiting for AgentRunner process ${instance.pid} to stop.`);
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
  const resolvedMigrationReason = deps.getWindowsTaskMigrationReason ?? getWindowsTaskMigrationReason;
  const resolvedSpawnDetachedDaemon = deps.spawnDetachedDaemon ?? spawnDetachedDaemon;
  const acknowledgeRestart = deps.acknowledgeRestart ?? (async () => undefined);
  const acknowledgePreparedHandoff = deps.acknowledgePreparedHandoff ?? acknowledgePreparedRestartHandoff;
  const resolvedPlatform = (deps.platform ?? getPlatform)();
  const exitProcess = deps.processExit ?? ((code: number) => process.exit(code));
  const resolvedLogger = deps.logger ?? logger;

  let autostartStatus = resolvedGetAutostartStatus();
  if (resolvedPlatform === 'win32' || autostartStatus.platform === 'task-scheduler') {
    // A web restart (and therefore `agentrunner update`'s auto-update flow) is the
    // only path most existing installs ever take. Without this check they would
    // keep their legacy `<Command>powershell.exe</Command>` action forever, so
    // re-register whenever the live definition is not the native launcher.
    const missingRegistration = !autostartStatus.registered;
    const migrationReason = missingRegistration ? null : resolvedMigrationReason();
    if (missingRegistration || migrationReason) {
      const outdatedDescription = migrationReason ? WINDOWS_TASK_MIGRATION_DESCRIPTIONS[migrationReason] : '';
      if (!deps.config) {
        return {
          status: 'retryable-failure',
          handoffId: randomUUID(),
          replacementReady: false,
          acknowledged: false,
          retryableFailure: true,
          reason: 'autostart-repair-failed',
          error: missingRegistration
            ? 'Windows Task Scheduler autostart is missing and runtime configuration is unavailable.'
            : `Windows Task Scheduler autostart still ${outdatedDescription} and runtime configuration is unavailable.`,
        };
      }

      try {
        resolvedLogger.info(
          missingRegistration
            ? 'Windows Task Scheduler autostart is missing — repairing it before restart'
            : `Windows Task Scheduler autostart still ${outdatedDescription} — re-registering it`,
        );
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
    let preparation: RestartHandoffPreparation;
    try {
      preparation = await resolvedScheduleWindowsTaskRestart();
    } catch (error) {
      // Defensive: scheduleWindowsTaskRestart owns a structured contract, but a
      // thrown error here must not escalate into a whole failed poll cycle.
      resolvedLogger.info('Restart handoff preparation threw — keeping the current runner alive for retry');
      return {
        status: 'retryable-failure',
        handoffId: randomUUID(),
        replacementReady: false,
        acknowledged: false,
        retryableFailure: true,
        reason: 'helper-preparation-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

export const restartDaemon = async (deps: RestartDeps = {}): Promise<RestartOutcome> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedRestartAutostartService = deps.restartAutostartService ?? restartAutostartService;
  const resolvedSpawnDetachedDaemon = deps.spawnDetachedDaemon ?? spawnDetachedDaemon;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedLogger = deps.logger ?? logger;

  const autostartStatus = resolvedGetAutostartStatus();
  // Snapshot the live instance *before* anything is triggered. Without it a
  // restart cannot tell a genuine replacement from the previous runner that
  // simply never died — which is exactly how a failed restart reported success.
  const daemonStatus = await resolvedGetDaemonStatus();
  const previousInstance = toInstanceRef(daemonStatus);

  if (autostartStatus.registered && autostartStatus.platform === 'task-scheduler') {
    // `schtasks /End` owns termination here; signalling the runner ourselves would
    // race the task instance and can trip RestartOnFailure. The snapshot above is
    // what turns a silently discarded /Run into a reported failure.
    resolvedLogger.info('Restarting AgentRunner via registered Task Scheduler task', {
      previousPid: previousInstance?.pid ?? null,
    });
    await resolvedRestartAutostartService();
    return { previousInstance };
  }

  if (previousInstance) {
    resolvedLogger.info('Stopping AgentRunner before restart', { pid: previousInstance.pid });
    await waitForDaemonToStop(previousInstance.pid, {
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
    return { previousInstance };
  }

  resolvedLogger.info('Starting AgentRunner in background without autostart registration');
  resolvedSpawnDetachedDaemon();
  return { previousInstance };
};
