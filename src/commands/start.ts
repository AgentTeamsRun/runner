import { resolveRuntimeConfig } from "../config.js";
import { startPolling } from "../poller.js";
import { DaemonApiClient } from "../api-client.js";
import { ProcessLauncher } from "../process-launcher.js";
import { createTriggerHandler } from "../handlers/trigger-handler.js";

export const runStartCommand = async (): Promise<void> => {
  const config = await resolveRuntimeConfig();
  const client = new DaemonApiClient(config.apiUrl, config.daemonToken);
  const launcher = new ProcessLauncher();
  const triggerHandler = createTriggerHandler(config, client, launcher);
  await startPolling(config, triggerHandler);
};
