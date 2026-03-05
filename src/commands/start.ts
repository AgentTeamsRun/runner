import { resolveRuntimeConfig } from "../config.js";
import { startPolling } from "../poller.js";
import { DaemonApiClient } from "../api-client.js";
import { createTriggerHandler } from "../handlers/trigger-handler.js";
import { writePidFile, removePidFile } from "../pid.js";

export const runStartCommand = async (): Promise<void> => {
  await writePidFile();

  const cleanup = async () => {
    await removePidFile();
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
  process.on("exit", () => {
    // Synchronous best-effort — PID file may already be removed by signal handler.
  });

  const config = await resolveRuntimeConfig();
  const client = new DaemonApiClient(config.apiUrl, config.daemonToken);

  await startPolling(config, (onAuthPathDiscovered) =>
    createTriggerHandler({ config, client, onAuthPathDiscovered })
  );
};
