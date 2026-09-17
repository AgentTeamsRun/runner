import { restartDaemon, terminateDaemonInstance, waitForDaemonToStart } from '../daemon-control.js';
import { confirmDaemonReplacement } from '../restart-confirmation.js';
import { logger } from '../logger.js';

type RunRestartCommandDeps = {
  restartDaemon?: typeof restartDaemon;
  waitForDaemonToStart?: typeof waitForDaemonToStart;
  terminateDaemonInstance?: typeof terminateDaemonInstance;
  confirmDaemonReplacement?: typeof confirmDaemonReplacement;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

export const runRestartCommand = async (deps: RunRestartCommandDeps = {}): Promise<void> => {
  const resolvedRestartDaemon = deps.restartDaemon ?? restartDaemon;
  const resolvedConfirmDaemonReplacement = deps.confirmDaemonReplacement ?? confirmDaemonReplacement;
  const resolvedLogger = deps.logger ?? logger;

  const outcome = await resolvedRestartDaemon();
  const confirmation = await resolvedConfirmDaemonReplacement('restart', outcome, {
    waitForDaemonToStart: deps.waitForDaemonToStart,
    terminateDaemonInstance: deps.terminateDaemonInstance,
    logger: resolvedLogger,
  });

  resolvedLogger.info('AgentRunner restart completed', {
    pid: confirmation.pid,
    previousPid: outcome.previousInstance?.pid ?? null,
  });
};
