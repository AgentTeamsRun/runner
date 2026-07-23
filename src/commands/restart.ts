import { restartDaemon, waitForDaemonToStart } from '../daemon-control.js';
import { logger } from '../logger.js';

type RunRestartCommandDeps = {
  restartDaemon?: typeof restartDaemon;
  waitForDaemonToStart?: typeof waitForDaemonToStart;
  logger?: Pick<typeof logger, 'info'>;
};

export const runRestartCommand = async (deps: RunRestartCommandDeps = {}): Promise<void> => {
  const resolvedRestartDaemon = deps.restartDaemon ?? restartDaemon;
  const resolvedWaitForDaemonToStart = deps.waitForDaemonToStart ?? waitForDaemonToStart;
  const resolvedLogger = deps.logger ?? logger;

  await resolvedRestartDaemon();

  const status = await resolvedWaitForDaemonToStart();
  if (status.running) {
    resolvedLogger.info('AgentRunner restart completed', { pid: status.pid });
    return;
  }

  // The runner never reported running within the timeout. Fail with a non-zero
  // exit code so shells and install automation don't treat a broken restart as
  // success — the whole point of the confirmation step.
  throw new Error(
    'AgentRunner restart was triggered but the runner did not report running within the timeout. ' +
      'Check `agentrunner status`.',
  );
};
