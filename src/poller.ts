import { logger } from "./logger.js";
import { DaemonApiClient } from "./api-client.js";
import { runCleanup } from "./utils/runner-cleanup.js";
import type { DaemonTrigger, RuntimeConfig } from "./types.js";

type TriggerHandlerFactory = (onAuthPathDiscovered: (authPath: string) => void) => (trigger: DaemonTrigger) => Promise<void>;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type PollingDependencies = {
  createClient?: (config: RuntimeConfig) => Pick<DaemonApiClient, "fetchPendingTrigger" | "claimTrigger" | "fetchOrphanedCancelRequested" | "updateTriggerStatus">;
  runCleanup?: (authPath: string) => Promise<void>;
  setInterval?: typeof global.setInterval;
  clearInterval?: typeof global.clearInterval;
  processOn?: (event: NodeJS.Signals, listener: () => void) => void;
  processExit?: (code: number) => never;
  now?: () => number;
  keepAlive?: () => Promise<void>;
};

export const startPolling = async (
  config: RuntimeConfig,
  createHandler: TriggerHandlerFactory,
  dependencies: PollingDependencies = {}
): Promise<void> => {
  const client = dependencies.createClient?.(config) ?? new DaemonApiClient(config.apiUrl, config.daemonToken);
  const cleanupRunner = dependencies.runCleanup ?? runCleanup;
  const now = dependencies.now ?? Date.now;
  const registerInterval = dependencies.setInterval ?? global.setInterval;
  const unregisterInterval = dependencies.clearInterval ?? global.clearInterval;
  const registerSignal = dependencies.processOn ?? ((event, listener) => process.on(event, listener));
  const exitProcess = dependencies.processExit ?? ((code) => process.exit(code));
  const keepAlive = dependencies.keepAlive ?? (() => new Promise<void>(() => {
    // Keep process alive until shutdown signal.
  }));
  let isPolling = false;

  const knownAuthPaths = new Set<string>();
  let lastCleanupAt = 0;

  const onAuthPathDiscovered = (authPath: string): void => {
    knownAuthPaths.add(authPath);
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

  const pollOnce = async () => {
    if (isPolling) {
      return;
    }

    isPolling = true;
    try {
      maybeRunCleanup();
      await autoCancelOrphanedTriggers();

      const pending = await client.fetchPendingTrigger();
      if (!pending) {
        return;
      }

      const claim = await client.claimTrigger(pending.id);
      if (claim.conflict) {
        logger.info("Trigger already claimed by another daemon", { triggerId: pending.id });
        return;
      }

      if (!claim.ok) {
        logger.warn("Claim was rejected", { triggerId: pending.id });
        return;
      }

      void onTrigger(pending).catch((error) => {
        logger.error("Trigger handler execution failed", {
          triggerId: pending.id,
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

  logger.info("Daemon polling started", {
    apiUrl: config.apiUrl,
    pollingIntervalMs: config.pollingIntervalMs,
    timeoutMs: config.timeoutMs,
    runnerCmd: config.runnerCmd
  });

  await pollOnce();

  const shutdown = () => {
    unregisterInterval(interval);
    logger.info("Daemon stopped");
    exitProcess(0);
  };

  registerSignal("SIGINT", shutdown);
  registerSignal("SIGTERM", shutdown);

  await keepAlive();
};
