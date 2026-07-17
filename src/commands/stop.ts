import { logger } from '../logger.js';
import { getDaemonStatus, removePidFile } from '../pid.js';

type StopCommandDeps = {
  getDaemonStatus?: typeof getDaemonStatus;
  removePidFile?: typeof removePidFile;
  kill?: typeof process.kill;
  logger?: Pick<typeof logger, 'info' | 'error'>;
};

export const runStopCommand = async (deps: StopCommandDeps = {}): Promise<void> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedRemovePidFile = deps.removePidFile ?? removePidFile;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedLogger = deps.logger ?? logger;

  const { running, pid } = await resolvedGetDaemonStatus();

  if (!running || pid === null) {
    resolvedLogger.info('Daemon is not running');
    return;
  }

  try {
    resolvedKill(pid, 'SIGTERM');
    resolvedLogger.info('Sent SIGTERM to daemon', { pid });
  } catch (error) {
    resolvedLogger.error('Failed to stop daemon', {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await resolvedRemovePidFile();
};
