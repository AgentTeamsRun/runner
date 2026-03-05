import { logger } from "../logger.js";
import { getDaemonStatus } from "../pid.js";
import { getAutostartStatus } from "../autostart.js";

export const runStatusCommand = async (): Promise<void> => {
  const daemonStatus = await getDaemonStatus();
  const autostartStatus = getAutostartStatus();

  if (daemonStatus.running) {
    logger.info("Daemon is running", { pid: daemonStatus.pid });
  } else {
    logger.info("Daemon is not running");
  }

  if (autostartStatus.registered) {
    logger.info("Autostart is enabled", { platform: autostartStatus.platform });
  } else {
    logger.info("Autostart is not registered", { platform: autostartStatus.platform });
  }
};
