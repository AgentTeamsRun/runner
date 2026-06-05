import { logger } from "./logger.js";
import { DaemonApiClient } from "./api-client.js";
import { runCleanup } from "./utils/runner-cleanup.js";
import { runConventionSync } from "./utils/convention-sync.js";
import { loadAuthPaths, saveAuthPath } from "./utils/auth-path-store.js";
import { removeWorktree, resolveWorktreePath } from "./utils/git-worktree.js";
import { existsSync } from "node:fs";
import type { DaemonTrigger, RuntimeConfig } from "./types.js";
import { maybeAutoUpdate } from "./utils/auto-update.js";
import { executeRestartRequest } from "./daemon-control.js";
import { createPowerSaveBlocker, type PowerSaveBlocker } from "./utils/power-save-blocker.js";


type TriggerHandlerFactory = (onAuthPathDiscovered: (authPath: string) => void) => (trigger: DaemonTrigger) => Promise<void>;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONVENTION_SYNC_INTERVAL_MS = 60 * 60 * 1000;

type PollingDependencies = {
  createClient?: (config: RuntimeConfig) => Pick<DaemonApiClient, "fetchPendingTrigger" | "claimTrigger" | "fetchOrphanedCancelRequested" | "updateTriggerStatus" | "fetchPendingWorktreeRemovals" | "reportWorktreeStatus" | "notifyUpdate" | "ackRestartRequest">;
  runCleanup?: (authPath: string) => Promise<void>;
  runConventionSync?: (authPath: string) => Promise<void>;
  removeWorktree?: typeof removeWorktree;
  maybeAutoUpdate?: typeof maybeAutoUpdate;
  executeRestartRequest?: typeof executeRestartRequest;
  setInterval?: typeof global.setInterval;
  clearInterval?: typeof global.clearInterval;
  processOn?: (event: NodeJS.Signals, listener: () => void) => void;
  processExit?: (code: number) => never;
  now?: () => number;
  keepAlive?: () => Promise<void>;
  loadAuthPaths?: () => string[];
  saveAuthPath?: (authPath: string) => string;
  powerSaveBlocker?: PowerSaveBlocker;
};

export const startPolling = async (
  config: RuntimeConfig,
  createHandler: TriggerHandlerFactory,
  dependencies: PollingDependencies = {}
): Promise<void> => {
  const client = dependencies.createClient?.(config) ?? new DaemonApiClient(config.apiUrl, config.daemonToken);
  const cleanupRunner = dependencies.runCleanup ?? runCleanup;
  const conventionSync = dependencies.runConventionSync ?? runConventionSync;
  const removeWorktreeFn = dependencies.removeWorktree ?? removeWorktree;
  const autoUpdate = dependencies.maybeAutoUpdate ?? maybeAutoUpdate;
  const performRestart = dependencies.executeRestartRequest ?? executeRestartRequest;
  const now = dependencies.now ?? Date.now;
  const registerInterval = dependencies.setInterval ?? global.setInterval;
  const unregisterInterval = dependencies.clearInterval ?? global.clearInterval;
  const registerSignal = dependencies.processOn ?? ((event, listener) => process.on(event, listener));
  const exitProcess = dependencies.processExit ?? ((code) => process.exit(code));
  const keepAlive = dependencies.keepAlive ?? (() => new Promise<void>(() => {
    // Keep process alive until shutdown signal.
  }));
  const loadPersistedAuthPaths = dependencies.loadAuthPaths ?? loadAuthPaths;
  const persistAuthPath = dependencies.saveAuthPath ?? saveAuthPath;
  // 절전 방지는 daemon polling lifecycle이 소유한다. daemon이 살아 있는 동안(폴링/대기/실행)
  // 절전을 막고, 종료 시 해제한다. (배터리/비 macOS는 유틸 내부에서 no-op)
  const powerSaveBlocker = dependencies.powerSaveBlocker ?? createPowerSaveBlocker({ enabled: config.preventSleepWhileBusy });
  let isPolling = false;

  const knownAuthPaths = new Set<string>(loadPersistedAuthPaths());
  let lastCleanupAt = 0;
  const lastConventionSyncAt = new Map<string, number>();

  const onAuthPathDiscovered = (authPath: string): void => {
    if (knownAuthPaths.has(authPath)) {
      return;
    }

    knownAuthPaths.add(authPath);
    try {
      persistAuthPath(authPath);
    } catch (error) {
      logger.warn("Failed to persist auth path", {
        authPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const onTrigger = createHandler(onAuthPathDiscovered);

  const maybeRunCleanup = () => {
    const currentTime = now();
    if (currentTime - lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanupAt = currentTime;

    for (const authPath of knownAuthPaths) {
      void cleanupRunner(authPath).catch((error) => {
        logger.warn("Scheduled cleanup failed", {
          authPath,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  };

  const maybeRunConventionSync = () => {
    const currentTime = now();
    for (const authPath of knownAuthPaths) {
      const lastSync = lastConventionSyncAt.get(authPath) ?? 0;
      if (currentTime - lastSync < CONVENTION_SYNC_INTERVAL_MS) {
        continue;
      }
      lastConventionSyncAt.set(authPath, currentTime);
      void conventionSync(authPath).catch((error) => {
        logger.warn("Scheduled convention sync failed", {
          authPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const autoCancelOrphanedTriggers = async () => {
    try {
      const triggerIds = await client.fetchOrphanedCancelRequested();
      for (const triggerId of triggerIds) {
        try {
          await client.updateTriggerStatus(triggerId, "CANCELLED", "Automatically cancelled: runner is no longer active");
          logger.info("Auto-cancelled orphaned trigger", { triggerId });
        } catch (error) {
          logger.warn("Failed to auto-cancel orphaned trigger", {
            triggerId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      logger.warn("Failed to fetch orphaned cancel-requested triggers", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const processWorktreeRemovals = async () => {
    try {
      const triggers = await client.fetchPendingWorktreeRemovals();
      for (const trigger of triggers) {
        try {
          let removeSucceeded = false;
          const effectiveWorktreeId = trigger.worktreeId ?? trigger.id;
          let matchedAuthPath = false;
          for (const authPath of knownAuthPaths) {
            const worktreePath = resolveWorktreePath(authPath, effectiveWorktreeId);
            if (!existsSync(worktreePath)) {
              continue;
            }

            matchedAuthPath = true;
            try {
              removeWorktreeFn(authPath, worktreePath, effectiveWorktreeId);
              removeSucceeded = true;
              logger.info("Worktree removed for trigger", { triggerId: trigger.id, worktreePath });
              break;
            } catch (error) {
              const worktreeError = error instanceof Error ? error.message : String(error);
              logger.warn("Failed to remove worktree for trigger", {
                triggerId: trigger.id,
                authPath,
                worktreePath,
                error: worktreeError
              });
              await client.reportWorktreeStatus(trigger.id, "FAILED", worktreeError);
              break;
            }
          }

          if (removeSucceeded) {
            await client.reportWorktreeStatus(trigger.id, "REMOVED");
          } else if (!matchedAuthPath) {
            const worktreeError = `Failed to remove RunnerBox: worktree path was not found for ${effectiveWorktreeId}`;
            logger.warn("Could not find authPath for worktree removal", {
              triggerId: trigger.id,
              worktreeId: effectiveWorktreeId
            });
            await client.reportWorktreeStatus(trigger.id, "FAILED", worktreeError);
          }
        } catch (error) {
          logger.warn("Failed to remove worktree for trigger", {
            triggerId: trigger.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      logger.warn("Failed to fetch pending worktree removals", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const pollOnce = async () => {
    if (isPolling) {
      return;
    }

    isPolling = true;
    try {
      maybeRunCleanup();
      maybeRunConventionSync();
      await autoCancelOrphanedTriggers();
      await processWorktreeRemovals();

      const pendingResponse = await client.fetchPendingTrigger();
      const trigger = pendingResponse.data;

      // 웹에서 요청된 재시작은 pending 작업 유무와 무관하게 우선 처리한다.
      // 서버는 ack가 도착할 때까지 플래그를 유지하므로, ack 실패 시에는 다음 폴링에서
      // 다시 시도되어 요청이 조용히 소실되지 않는다.
      if (pendingResponse.meta?.restartRequested) {
        try {
          await client.ackRestartRequest();
        } catch (error) {
          logger.warn("Failed to ack restart request — will retry on next poll", {
            error: error instanceof Error ? error.message : String(error)
          });
          return;
        }

        performRestart({ processExit: exitProcess });
        return;
      }

      if (!trigger) {
        // idle 상태에서 자동 업데이트 시도
        try {
          await autoUpdate(pendingResponse.meta, {
            onRunnerUpdated: (version) => client.notifyUpdate(version, "runner")
          });
        } catch (error) {
          logger.error("Auto-update check failed", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      const claim = await client.claimTrigger(trigger.id);
      if (claim.conflict) {
        logger.info("Trigger already claimed by another daemon", { triggerId: trigger.id });
        return;
      }

      if (!claim.ok) {
        logger.warn("Claim was rejected", { triggerId: trigger.id });
        return;
      }

      void onTrigger(trigger).catch((error) => {
        logger.error("Trigger handler execution failed", {
          triggerId: trigger.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    } catch (error) {
      logger.error("Polling cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      isPolling = false;
    }
  };

  const interval = registerInterval(() => {
    void pollOnce();
  }, config.pollingIntervalMs);

  // daemon 시작과 함께 절전 방지를 한 번 acquire한다. polling cycle마다 반복하지 않는다.
  const releasePowerSaveBlocker = powerSaveBlocker.acquire("daemon-polling");

  logger.info("Daemon polling started", {
    apiUrl: config.apiUrl,
    pollingIntervalMs: config.pollingIntervalMs,
    timeoutMs: config.timeoutMs,
    runnerCmd: config.runnerCmd
  });

  await pollOnce();

  const shutdown = () => {
    releasePowerSaveBlocker();
    unregisterInterval(interval);
    logger.info("Daemon stopped");
    exitProcess(0);
  };

  registerSignal("SIGINT", shutdown);
  registerSignal("SIGTERM", shutdown);

  await keepAlive();
  // keepAlive가 resolve되는 정상 종료 경로(주로 테스트)에서도 release를 보장한다. release는 idempotent하다.
  releasePowerSaveBlocker();
};
