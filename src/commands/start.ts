import { randomUUID } from 'node:crypto';
import { platform as getPlatform } from 'node:os';
import { resolveRuntimeConfig } from '../config.js';
import { startPolling } from '../poller.js';
import { DaemonApiClient } from '../api-client.js';
import { createTriggerHandler } from '../handlers/trigger-handler.js';
import { writePidFile, removePidFile, removeOwnPidFileSync, markDaemonReady } from '../pid.js';
import { listenForShutdownRequests } from '../shutdown-channel.js';
import { logger } from '../logger.js';
import { refreshWindowsPathFromRegistry } from '../windows-path.js';
import { activatePreparedRestartHandoff } from '../restart-handoff.js';
import { migrateWindowsAutostartOnBoot } from '../autostart.js';

/**
 * The Windows Task Scheduler wrapper injects a PATH snapshot
 * frozen at registration time, so runner CLIs installed afterwards become
 * unresolvable. Re-read the live registry PATH at startup to stay agnostic to
 * how each CLI was installed (npm, scoop, choco, native installers, ...).
 */
const refreshExecutablePath = (): void => {
  const addedEntries = refreshWindowsPathFromRegistry();
  if (addedEntries.length > 0) {
    logger.info('Merged live registry PATH entries missing from the autostart snapshot', {
      addedEntries,
    });
  }
};

/**
 * Default CODEX_SANDBOX_LEVEL to "off" when not explicitly set.
 * Auto-start services (launchd/systemd/Task Scheduler) inject CODEX_SANDBOX_LEVEL=off
 * in their service files. For manual `agentrunner start`, we apply the same
 * default so both paths behave identically.
 */
const ensureCodexSandboxDefault = (): void => {
  if (!process.env.CODEX_SANDBOX_LEVEL) {
    process.env.CODEX_SANDBOX_LEVEL = 'off';
    logger.info("CODEX_SANDBOX_LEVEL not set; defaulting to 'off' to match auto-start behavior");
  }
};

type StartCommandDeps = {
  refreshExecutablePath?: () => void;
  ensureCodexSandboxDefault?: () => void;
  activatePreparedRestartHandoff?: typeof activatePreparedRestartHandoff;
  writePidFile?: typeof writePidFile;
  removePidFile?: typeof removePidFile;
  markDaemonReady?: typeof markDaemonReady;
  migrateWindowsAutostartOnBoot?: () => Promise<void>;
  processOn?: (event: 'SIGINT' | 'SIGTERM' | 'exit', listener: () => void) => void;
  resolveRuntimeConfig?: typeof resolveRuntimeConfig;
  startPolling?: typeof startPolling;
  platform?: () => NodeJS.Platform;
  listenForShutdownRequests?: typeof listenForShutdownRequests;
  removeOwnPidFileSync?: typeof removeOwnPidFileSync;
  processExit?: (code: number) => void;
  processPid?: number;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

export const runStartCommand = async (deps: StartCommandDeps = {}): Promise<void> => {
  const resolvedLogger = deps.logger ?? logger;
  (deps.refreshExecutablePath ?? refreshExecutablePath)();
  (deps.ensureCodexSandboxDefault ?? ensureCodexSandboxDefault)();
  const activatedHandoff = await (deps.activatePreparedRestartHandoff ?? activatePreparedRestartHandoff)();
  if (activatedHandoff) {
    resolvedLogger.info('Replacement runner activated after restart handoff');
  }

  // Windows에는 다른 프로세스의 종료 핸들러를 깨우는 신호가 없으므로, 인스턴스 전용 종료 채널을 연다.
  // PID 기록보다 먼저 열어야 한다: 기록을 읽은 `stop`이 아직 없는 수신부에 요청하는 틈이 생기지 않는다.
  const isWindows = (deps.platform ?? getPlatform)() === 'win32';
  const instanceId = randomUUID();
  let controlToken: string | null = null;
  let shutdownPoller: (() => Promise<void>) | null = null;
  if (isWindows) {
    const token = randomUUID();
    try {
      await (deps.listenForShutdownRequests ?? listenForShutdownRequests)(
        { pid: deps.processPid ?? process.pid, instanceId, controlToken: token },
        () => {
          resolvedLogger.info('Shutdown requested through the control channel');
          if (shutdownPoller) {
            void shutdownPoller();
            return;
          }
          // 아직 폴링을 시작하지 않았다: 취소할 실행이 없으므로 바로 끝낸다.
          (deps.processExit ?? ((code: number) => process.exit(code)))(0);
        },
      );
      controlToken = token;
    } catch (error) {
      // 채널 없이도 러너는 동작한다. 기록에 토큰을 남기지 않아 `stop`이 채널 없는 러너로 다루게 한다.
      resolvedLogger.warn('Could not open the shutdown control channel; stop will fall back to termination', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await (deps.writePidFile ?? writePidFile)(isWindows ? { instanceId, controlToken } : undefined);

  const cleanup = async () => {
    await (deps.removePidFile ?? removePidFile)();
  };

  const processOn = deps.processOn ?? ((event, listener) => process.on(event, listener));
  processOn('SIGINT', () => void cleanup());
  processOn('SIGTERM', () => void cleanup());
  processOn('exit', () => {
    // Synchronous best-effort — PID file may already be removed by signal handler.
    // Windows에서는 신호 핸들러가 돌지 않으므로 여기서 자기 기록만 지운다(교체 러너의 기록은 건드리지 않는다).
    if (isWindows) {
      (deps.removeOwnPidFileSync ?? removeOwnPidFileSync)(instanceId);
    }
  });

  const config = await (deps.resolveRuntimeConfig ?? resolveRuntimeConfig)();
  const client = new DaemonApiClient(config.apiUrl, config.daemonToken);

  // Everything a replacement runner needs is now in place. Stamp the PID record
  // as ready so `agentrunner restart` can require an initialized instance rather
  // than a process that merely exists — a starved autostart process reaches
  // neither point, and one that stalls mid-initialization reaches only the first.
  await (deps.markDaemonReady ?? markDaemonReady)();

  // Re-registering the scheduled task only changes what the *next* start uses,
  // so it must not sit between process creation and the readiness stamp: that
  // stretch is what `agentrunner restart` waits out, and the migration's half
  // dozen subprocesses (SHA-256 verification, file copies, icacls, schtasks)
  // are slowest under exactly the CPU pressure the restart timeout budgets for.
  await (deps.migrateWindowsAutostartOnBoot ?? migrateWindowsAutostartOnBoot)();

  await (deps.startPolling ?? startPolling)(
    config,
    (onAuthPathDiscovered) => createTriggerHandler({ config, client, onAuthPathDiscovered }),
    isWindows
      ? {
          onShutdownAvailable: (shutdown) => {
            shutdownPoller = shutdown;
          },
        }
      : undefined,
  );
};
