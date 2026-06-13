import { setTimeout as delay } from 'node:timers/promises';
import { platform as getPlatform } from 'node:os';
import { getAutostartStatus, launchWindowsHiddenDaemon, restartAutostartService } from './autostart.js';
import { logger } from './logger.js';
import { getDaemonStatus } from './pid.js';
import { spawnExecutable } from './executable.js';

type RunningDaemonStatus = {
  running: boolean;
  pid: number | null;
};

type DetachedChildProcess = {
  unref: () => void;
};

type RestartDeps = {
  getDaemonStatus?: () => Promise<RunningDaemonStatus>;
  getAutostartStatus?: typeof getAutostartStatus;
  restartAutostartService?: typeof restartAutostartService;
  spawnDetachedDaemon?: () => DetachedChildProcess | void;
  kill?: typeof process.kill;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<typeof logger, 'info'>;
};

type ExecuteRestartDeps = {
  getAutostartStatus?: typeof getAutostartStatus;
  spawnDetachedDaemon?: () => DetachedChildProcess | void;
  platform?: typeof getPlatform;
  processExit?: (code: number) => never;
  logger?: Pick<typeof logger, 'info'>;
};

const restartPollIntervalMs = 100;
const stopTimeoutMs = 10_000;

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

export const spawnDetachedDaemon = (): DetachedChildProcess | void => {
  // On Windows, spawnExecutable wraps the call in `powershell.exe -Command`,
  // which flashes a console window even with `windowsHide: true` because the
  // `.cmd` shim creates its own console host. Use the hidden VBS launcher
  // instead so users never see a terminal pop up.
  if (getPlatform() === 'win32') {
    launchWindowsHiddenDaemon();
    return;
  }

  const child = spawnExecutable('agentrunner', ['start'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  return child;
};

// Run from within the daemon itself when a web restart request is received.
// We can't call restartDaemon() here because that would SIGTERM our own PID
// before we get a chance to spawn the replacement; instead we either exit and
// let the OS supervisor restart us, or spawn a replacement and exit cleanly.
export const executeRestartRequest = (deps: ExecuteRestartDeps = {}): void => {
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedSpawnDetachedDaemon = deps.spawnDetachedDaemon ?? spawnDetachedDaemon;
  const resolvedPlatform = (deps.platform ?? getPlatform)();
  const exitProcess = deps.processExit ?? ((code: number) => process.exit(code));
  const resolvedLogger = deps.logger ?? logger;

  const autostartStatus = resolvedGetAutostartStatus();
  const supervisedRespawn =
    autostartStatus.registered && (autostartStatus.platform === 'launchd' || autostartStatus.platform === 'systemd');

  if (supervisedRespawn) {
    resolvedLogger.info('Restart requested — exiting non-zero so the OS supervisor restarts the daemon', {
      platform: autostartStatus.platform,
    });
    exitProcess(1);
    return;
  }

  resolvedLogger.info('Restart requested — spawning new daemon and exiting', {
    platform: autostartStatus.platform,
    registered: autostartStatus.registered,
    osPlatform: resolvedPlatform,
  });
  resolvedSpawnDetachedDaemon();
  exitProcess(0);
};

export const restartDaemon = async (deps: RestartDeps = {}): Promise<void> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedRestartAutostartService = deps.restartAutostartService ?? restartAutostartService;
  const resolvedSpawnDetachedDaemon = deps.spawnDetachedDaemon ?? spawnDetachedDaemon;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedLogger = deps.logger ?? logger;

  const daemonStatus = await resolvedGetDaemonStatus();
  if (daemonStatus.running && daemonStatus.pid !== null) {
    resolvedLogger.info('Stopping AgentRunner before restart', { pid: daemonStatus.pid });
    await waitForDaemonToStop(daemonStatus.pid, {
      getDaemonStatus: resolvedGetDaemonStatus,
      kill: resolvedKill,
      sleep: resolvedSleep,
    });
  }

  const autostartStatus = resolvedGetAutostartStatus();
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
