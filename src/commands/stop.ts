import { logger } from "../logger.js";
import { getDaemonStatus, removePidFile } from "../pid.js";

export const runStopCommand = async (): Promise<void> => {
  const { running, pid } = await getDaemonStatus();

  if (!running || pid === null) {
    logger.info("Daemon is not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    logger.info("Sent SIGTERM to daemon", { pid });
  } catch (error) {
    logger.error("Failed to stop daemon", {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  await removePidFile();
};
