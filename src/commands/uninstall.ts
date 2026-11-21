import { logger } from '../logger.js';
import { getDaemonStatus, removePidFile, verifyRecordedDaemonInstance } from '../pid.js';
import { getAutostartStatus, unregisterAutostart } from '../autostart.js';

type UninstallCommandDeps = {
  getAutostartStatus?: typeof getAutostartStatus;
  unregisterAutostart?: typeof unregisterAutostart;
  getDaemonStatus?: typeof getDaemonStatus;
  removePidFile?: typeof removePidFile;
  verifyRecordedDaemonInstance?: (pid: number) => ReturnType<typeof verifyRecordedDaemonInstance>;
  kill?: typeof process.kill;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
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
    // `agentrunner stop`과 같은 이유로, PID를 재사용한 무관한 프로세스에는 신호를 보내지 않는다.
    const verification = await (deps.verifyRecordedDaemonInstance ?? verifyRecordedDaemonInstance)(pid);
    if (verification === 'mismatch') {
      resolvedLogger.warn(
        'The recorded AgentRunner PID now belongs to an unrelated process — discarding the stale record',
        { pid },
      );
    } else {
      try {
        resolvedKill(pid, 'SIGTERM');
        resolvedLogger.info('Stopped running daemon', { pid });
      } catch {
        // Process may have exited between check and kill.
      }
    }
    await resolvedRemovePidFile();
  }

  if (!isWindowsTask) {
    await resolvedUnregisterAutostart();
  }

  resolvedLogger.info('Uninstall completed. Daemon service removed and autostart unregistered.');
};
