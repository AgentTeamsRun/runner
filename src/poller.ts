import { logger } from "./logger.js";
import { DaemonApiClient } from "./api-client.js";
import type { DaemonTrigger, RuntimeConfig } from "./types.js";

type TriggerHandler = (trigger: DaemonTrigger) => Promise<void>;

export const startPolling = async (config: RuntimeConfig, onTrigger: TriggerHandler): Promise<void> => {
  const client = new DaemonApiClient(config.apiUrl, config.daemonToken);
  let isPolling = false;

  const pollOnce = async () => {
    if (isPolling) {
      return;
    }

    isPolling = true;
    try {
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

  const interval = setInterval(() => {
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
    clearInterval(interval);
    logger.info("Daemon stopped");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {
    // Keep process alive until shutdown signal.
  });
};
