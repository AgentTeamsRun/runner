import { logger } from '../logger.js';
import { getDaemonStatus, removePidFile } from '../pid.js';
import { getAutostartStatus, unregisterAutostart } from '../autostart.js';

type UninstallCommandDeps = {
  getAutostartStatus?: typeof getAutostartStatus;
  unregisterAutostart?: typeof unregisterAutostart;
  getDaemonStatus?: typeof getDaemonStatus;
  removePidFile?: typeof removePidFile;
  kill?: typeof process.kill;
  logger?: Pick<typeof logger, 'info'>;
};

export const runUninstallCommand = async (deps: UninstallCommandDeps = {}): Promise<void> => {
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedUnregisterAutostart = deps.unregisterAutostart ?? unregisterAutostart;
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedRemovePidFile = deps.removePidFile ?? removePidFile;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedLogger = deps.logger ?? logger;

  const autostartStatus = resolvedGetAutostartStatus();
  const isWindowsTask = autostartStatus.platform === 'task-scheduler';
  if (isWindowsTask) {
    await resolvedUnregisterAutostart();
  }

  const { running, pid } = await resolvedGetDaemonStatus();

  if (running && pid !== null) {
    try {
      resolvedKill(pid, 'SIGTERM');
      resolvedLogger.info('Stopped running daemon', { pid });
    } catch {
      // Process may have exited between check and kill.
    }
    await resolvedRemovePidFile();
  }

  if (!isWindowsTask) {
    await resolvedUnregisterAutostart();
  }

  resolvedLogger.info('Uninstall completed. Daemon service removed and autostart unregistered.');
};
