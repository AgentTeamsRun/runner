import { createRequire } from 'node:module';
import { restartDaemon, terminateDaemonInstance, waitForDaemonToStart } from '../daemon-control.js';
import { confirmDaemonReplacement } from '../restart-confirmation.js';
import { runExecutableSync } from '../executable.js';
import { logger } from '../logger.js';
import { normalizeInstallError } from '../utils/npm-install-error.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version?: string };

const packageName = '@agentteams/runner';

type UpdateDeps = {
  runExecutableSync?: typeof runExecutableSync;
  restartDaemon?: typeof restartDaemon;
  waitForDaemonToStart?: typeof waitForDaemonToStart;
  terminateDaemonInstance?: typeof terminateDaemonInstance;
  confirmDaemonReplacement?: typeof confirmDaemonReplacement;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

const getCurrentVersion = (): string => packageJson.version ?? '0.0.0';

const readLatestVersion = (deps: Pick<Required<UpdateDeps>, 'runExecutableSync' | 'logger'>): string | null => {
  try {
    const latestVersion = deps.runExecutableSync('npm', ['view', packageName, 'version']).trim();
    return latestVersion.length > 0 ? latestVersion : null;
  } catch (error) {
    deps.logger.warn('Failed to resolve latest AgentRunner version before update', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export const runUpdateCommand = async (deps: UpdateDeps = {}): Promise<void> => {
  const resolvedRunExecutableSync = deps.runExecutableSync ?? runExecutableSync;
  const resolvedRestartDaemon = deps.restartDaemon ?? restartDaemon;
  const resolvedLogger = deps.logger ?? logger;

  const currentVersion = getCurrentVersion();
  const latestVersion = readLatestVersion({
    runExecutableSync: resolvedRunExecutableSync,
    logger: resolvedLogger,
  });

  resolvedLogger.info('Updating AgentRunner package', {
    currentVersion,
    targetVersion: latestVersion ?? 'latest',
  });

  try {
    resolvedRunExecutableSync('npm', ['install', '-g', `${packageName}@latest`]);
  } catch (error) {
    throw normalizeInstallError(error);
  }

  resolvedLogger.info('Package update completed', {
    version: latestVersion ?? 'latest',
  });

  // The package on disk is new, but the running runner is still the old one.
  // Until a *different* instance reports ready the update has not taken effect,
  // so confirm the replacement instead of reporting success on the trigger.
  const outcome = await resolvedRestartDaemon();
  const confirmation = await (deps.confirmDaemonReplacement ?? confirmDaemonReplacement)('update', outcome, {
    waitForDaemonToStart: deps.waitForDaemonToStart,
    terminateDaemonInstance: deps.terminateDaemonInstance,
    logger: resolvedLogger,
  });

  resolvedLogger.info('AgentRunner update completed', {
    currentVersion,
    targetVersion: latestVersion ?? 'latest',
    pid: confirmation.pid,
    previousPid: outcome.previousInstance?.pid ?? null,
  });
};
