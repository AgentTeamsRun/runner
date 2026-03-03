import type { DaemonTrigger, RuntimeConfig } from "../types.js";
import { DaemonApiClient } from "../api-client.js";
import { ProcessLauncher } from "../process-launcher.js";
import { logger } from "../logger.js";

export const createTriggerHandler = (
  config: RuntimeConfig,
  client: DaemonApiClient,
  launcher: ProcessLauncher
) => {
  return async (trigger: DaemonTrigger): Promise<void> => {
    try {
      const runtime = await client.fetchTriggerRuntime(trigger.id);
      const status = await launcher.launch(config, {
        triggerId: trigger.id,
        prompt: trigger.prompt,
        runtime
      });
      await client.updateTriggerStatus(trigger.id, status);
      logger.info("Trigger completed", {
        triggerId: trigger.id,
        status
      });
    } catch (error) {
      logger.error("Trigger handling failed", {
        triggerId: trigger.id,
        error: error instanceof Error ? error.message : String(error)
      });

      try {
        await client.updateTriggerStatus(trigger.id, "FAILED");
      } catch (statusError) {
        logger.error("Failed to report trigger as FAILED", {
          triggerId: trigger.id,
          error: statusError instanceof Error ? statusError.message : String(statusError)
        });
      }
    }
  };
};
