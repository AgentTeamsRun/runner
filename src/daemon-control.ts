import { setTimeout as delay } from "node:timers/promises";
import { getAutostartStatus, restartAutostartService } from "./autostart.js";
import { logger } from "./logger.js";
import { getDaemonStatus } from "./pid.js";
import { spawnExecutable } from "./executable.js";

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
  spawnDetachedDaemon?: () => DetachedChildProcess;
  kill?: typeof process.kill;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<typeof logger, "info">;
};

const restartPollIntervalMs = 100;
const stopTimeoutMs = 10_000;

const waitForDaemonToStop = async (
  pid: number,
  deps: Required<Pick<RestartDeps, "getDaemonStatus" | "kill" | "sleep">>
): Promise<void> => {
  deps.kill(pid, "SIGTERM");

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

export const spawnDetachedDaemon = (): DetachedChildProcess => {
  const child = spawnExecutable("agentrunner", ["start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    cwd: process.cwd()
  });
  child.unref();
  return child;
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
    resolvedLogger.info("Stopping AgentRunner before restart", { pid: daemonStatus.pid });
    await waitForDaemonToStop(daemonStatus.pid, {
      getDaemonStatus: resolvedGetDaemonStatus,
      kill: resolvedKill,
      sleep: resolvedSleep
    });
  }

  const autostartStatus = resolvedGetAutostartStatus();
  if (autostartStatus.registered) {
    resolvedLogger.info("Restarting AgentRunner via registered autostart service", {
      platform: autostartStatus.platform
    });
    await resolvedRestartAutostartService();
    return;
  }

  resolvedLogger.info("Starting AgentRunner in background without autostart registration");
  resolvedSpawnDetachedDaemon();
};
