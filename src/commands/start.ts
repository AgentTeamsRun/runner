import { resolveRuntimeConfig } from "../config.js";
import { startPolling } from "../poller.js";
import { DaemonApiClient } from "../api-client.js";
import { createTriggerHandler } from "../handlers/trigger-handler.js";
import { writePidFile, removePidFile } from "../pid.js";
import { logger } from "../logger.js";

/**
 * Default CODEX_SANDBOX_LEVEL to "off" when not explicitly set.
 * Auto-start services (launchd/systemd/Startup) inject CODEX_SANDBOX_LEVEL=off
 * in their service files. For manual `agentrunner start`, we apply the same
 * default so both paths behave identically.
 */
const ensureCodexSandboxDefault = (): void => {
  if (!process.env.CODEX_SANDBOX_LEVEL) {
    process.env.CODEX_SANDBOX_LEVEL = "off";
    logger.info("CODEX_SANDBOX_LEVEL not set; defaulting to 'off' to match auto-start behavior");
  }
};

export const runStartCommand = async (): Promise<void> => {
  ensureCodexSandboxDefault();
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
