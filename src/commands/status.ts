import { platform } from 'node:os';
import { logger } from '../logger.js';
import { getDaemonStatus } from '../pid.js';
import {
  getAutostartStatus,
  getWindowsTaskMigrationReason,
  WINDOWS_TASK_MIGRATION_DESCRIPTIONS,
} from '../autostart.js';

type StatusCommandDeps = {
  platform?: typeof platform;
  getDaemonStatus?: typeof getDaemonStatus;
  getAutostartStatus?: typeof getAutostartStatus;
  getWindowsTaskMigrationReason?: typeof getWindowsTaskMigrationReason;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

export const runStatusCommand = async (deps: StatusCommandDeps = {}): Promise<void> => {
  const resolvedLogger = deps.logger ?? logger;
  const daemonStatus = await (deps.getDaemonStatus ?? getDaemonStatus)();
  const autostartStatus = (deps.getAutostartStatus ?? getAutostartStatus)();

  if (daemonStatus.running) {
    resolvedLogger.info('Daemon is running', { pid: daemonStatus.pid, ready: daemonStatus.ready });
    if (!daemonStatus.ready) {
      // `agentrunner restart` tells the user to come here when it fails with
      // [stage: not-ready]; without this line the answer would be invisible.
      resolvedLogger.warn(
        'Daemon process is running but never finished initializing. ' +
          'Check the runner log for the stage it stopped at, then run `agentrunner restart`.',
      );
    }
  } else {
    resolvedLogger.info('Daemon is not running');
  }

  if (autostartStatus.registered) {
    resolvedLogger.info('Autostart is enabled', { platform: autostartStatus.platform });
  } else {
    resolvedLogger.info('Autostart is not registered', { platform: autostartStatus.platform });
  }

  if ((deps.platform ?? platform)() === 'win32' && autostartStatus.registered) {
    const migrationReason = (deps.getWindowsTaskMigrationReason ?? getWindowsTaskMigrationReason)();
    if (migrationReason) {
      resolvedLogger.warn(
        `Windows autostart still ${WINDOWS_TASK_MIGRATION_DESCRIPTIONS[migrationReason]}. ` +
          "It will migrate on the next runner start; run 'agentrunner restart' to apply it immediately.",
      );
    }
  }
};
