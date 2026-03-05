import { logger } from "../logger.js";
import { getDaemonStatus, removePidFile } from "../pid.js";
import { unregisterAutostart } from "../autostart.js";

export const runUninstallCommand = async (): Promise<void> => {
  // 1. Stop running daemon if any.
  const { running, pid } = await getDaemonStatus();

  if (running && pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
      logger.info("Stopped running daemon", { pid });
    } catch {
      // Process may have exited between check and kill.
    }
    await removePidFile();
  }

  // 2. Unregister autostart service.
  await unregisterAutostart();

  logger.info("Uninstall completed. Daemon service removed and autostart unregistered.");
};
