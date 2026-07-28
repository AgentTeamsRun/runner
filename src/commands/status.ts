import { platform } from 'node:os';
import { logger } from '../logger.js';
import { getDaemonStatus } from '../pid.js';
import { getAutostartStatus, windowsTaskNeedsNativeLauncherMigration } from '../autostart.js';

type StatusCommandDeps = {
  platform?: typeof platform;
  getDaemonStatus?: typeof getDaemonStatus;
  getAutostartStatus?: typeof getAutostartStatus;
  windowsTaskNeedsNativeLauncherMigration?: typeof windowsTaskNeedsNativeLauncherMigration;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

export const runStatusCommand = async (deps: StatusCommandDeps = {}): Promise<void> => {
  const resolvedLogger = deps.logger ?? logger;
  const daemonStatus = await (deps.getDaemonStatus ?? getDaemonStatus)();
  const autostartStatus = (deps.getAutostartStatus ?? getAutostartStatus)();

  if (daemonStatus.running) {
    resolvedLogger.info('Daemon is running', { pid: daemonStatus.pid });
  } else {
    resolvedLogger.info('Daemon is not running');
  }

  if (autostartStatus.registered) {
    resolvedLogger.info('Autostart is enabled', { platform: autostartStatus.platform });
  } else {
    resolvedLogger.info('Autostart is not registered', { platform: autostartStatus.platform });
  }

  if (
    (deps.platform ?? platform)() === 'win32' &&
    autostartStatus.registered &&
    (deps.windowsTaskNeedsNativeLauncherMigration ?? windowsTaskNeedsNativeLauncherMigration)()
  ) {
    resolvedLogger.warn(
      "Windows autostart still uses a console-bound action. It will migrate on the next runner start; run 'agentrunner restart' to apply it immediately.",
    );
  }
};
