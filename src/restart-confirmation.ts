import {
  terminateDaemonInstance,
  waitForDaemonToStart,
  type DaemonStartConfirmation,
  type RestartOutcome,
} from './daemon-control.js';
import { logger } from './logger.js';

/**
 * Which command is asking. Only used to name the operation in the failure text,
 * so an `agentrunner update` that could not bring the runner back never reads
 * as a failed `agentrunner restart`.
 */
export type RestartOperation = 'restart' | 'update';

export type ConfirmDaemonReplacementDeps = {
  waitForDaemonToStart?: typeof waitForDaemonToStart;
  terminateDaemonInstance?: typeof terminateDaemonInstance;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

const describeFailure = (operation: RestartOperation, stage: string, previousPid: number | null): string => {
  if (stage === 'stale-instance') {
    return (
      `AgentRunner ${operation} was triggered but the pre-restart instance (pid ${previousPid}) was never replaced ` +
      '[stage: stale-instance].'
    );
  }
  if (stage === 'not-ready') {
    return (
      `AgentRunner ${operation} started a replacement process, but it never finished initializing within the timeout ` +
      '[stage: not-ready]. Check the runner log for the stage it stopped at.'
    );
  }
  return (
    `AgentRunner ${operation} was triggered but no runner reported running within the timeout ` +
    `[stage: ${stage}]. Check \`agentrunner status\`.`
  );
};

/**
 * Wait until a *different* runner instance reports ready, and throw otherwise.
 * `restart` and `update` share this because both only trigger a replacement;
 * without the confirmation either one reports success while the runner is down.
 */
export const confirmDaemonReplacement = async (
  operation: RestartOperation,
  outcome: RestartOutcome,
  deps: ConfirmDaemonReplacementDeps = {},
): Promise<DaemonStartConfirmation> => {
  const resolvedWaitForDaemonToStart = deps.waitForDaemonToStart ?? waitForDaemonToStart;
  const resolvedTerminateDaemonInstance = deps.terminateDaemonInstance ?? terminateDaemonInstance;
  const resolvedLogger = deps.logger ?? logger;
  const { previousInstance } = outcome;

  let confirmation = await resolvedWaitForDaemonToStart({ previousInstance });
  if (confirmation.replaced) {
    return confirmation;
  }

  // The pre-restart runner is still the one in the PID file. On Windows that
  // means the scheduled task never owned it, so `schtasks /End` could not stop
  // it and the replacement would have to coexist with it. Stop the recorded
  // instance by identity and give the already-triggered replacement one more
  // chance before failing, so a retry never starts from a duplicated state.
  if (confirmation.stage === 'stale-instance' && previousInstance) {
    resolvedLogger.warn('The pre-restart AgentRunner instance survived the restart trigger — stopping it', {
      pid: previousInstance.pid,
    });
    try {
      await resolvedTerminateDaemonInstance(previousInstance);
    } catch (error) {
      // Stopping it failed too, so the old instance may still be alive. Never
      // point the user at `agentrunner start` here — a second instance would
      // then have to coexist with the one that refused to die.
      throw new Error(
        `${describeFailure(operation, 'stale-instance', previousInstance.pid)} Stopping it also failed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Check whether pid ${previousInstance.pid} is still alive and stop it manually before starting AgentRunner again.`,
      );
    }

    confirmation = await resolvedWaitForDaemonToStart({ previousInstance });
    if (confirmation.replaced) {
      return confirmation;
    }
  }

  // The runner never took over within the timeout. Fail with a non-zero exit
  // code and name the stage so shells and install automation don't treat a
  // broken restart as success — the whole point of the confirmation step.
  if (confirmation.stage === 'stale-instance') {
    throw new Error(
      `${describeFailure(operation, 'stale-instance', previousInstance?.pid ?? null)} ` +
        'The stale instance has been stopped; run `agentrunner start` or check `agentrunner status`.',
    );
  }
  throw new Error(describeFailure(operation, confirmation.stage, previousInstance?.pid ?? null));
};
