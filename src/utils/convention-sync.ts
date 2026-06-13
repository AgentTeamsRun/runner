import { spawn } from 'node:child_process';
import { logger } from '../logger.js';

type ConventionSyncDeps = {
  spawn?: typeof spawn;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

type ConventionStatusResult = {
  updateAvailable: boolean;
};

type AgentteamsCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const runAgentteamsConventionCommand = async (
  authPath: string,
  args: string[],
  spawnFn: typeof spawn,
  log: Pick<typeof logger, 'warn'>,
): Promise<AgentteamsCommandResult | null> => {
  try {
    return await new Promise<AgentteamsCommandResult | null>((resolve) => {
      const child = spawnFn('agentteams', ['convention', ...args], {
        cwd: authPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.on('error', (err) => {
        log.warn('Convention sync spawn error', {
          authPath,
          command: `agentteams convention ${args.join(' ')}`,
          error: err.message,
        });
        resolve(null);
      });

      child.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
    });
  } catch (error) {
    log.warn('Convention sync command failed', {
      authPath,
      command: `agentteams convention ${args.join(' ')}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const parseConventionStatus = (stdout: string): ConventionStatusResult | null => {
  const parsed = JSON.parse(stdout) as Partial<ConventionStatusResult>;
  if (typeof parsed.updateAvailable !== 'boolean') {
    return null;
  }
  return { updateAvailable: parsed.updateAvailable };
};

export const runConventionSync = async (authPath: string, deps: ConventionSyncDeps = {}): Promise<void> => {
  const log = deps.logger ?? logger;
  const spawnFn = deps.spawn ?? spawn;

  try {
    const statusResult = await runAgentteamsConventionCommand(authPath, ['status'], spawnFn, log);
    if (statusResult === null) {
      return;
    }

    if (statusResult.exitCode !== 0) {
      log.warn('Convention status exited with non-zero code', {
        authPath,
        exitCode: statusResult.exitCode,
        stderr: statusResult.stderr.trim() || undefined,
      });
      return;
    }

    let status: ConventionStatusResult | null = null;
    try {
      status = parseConventionStatus(statusResult.stdout);
    } catch (error) {
      log.warn('Convention status returned invalid JSON', {
        authPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!status) {
      log.warn('Convention status returned invalid payload', { authPath });
      return;
    }

    if (!status.updateAvailable) {
      log.info('Convention sync skipped; conventions are up to date', { authPath });
      return;
    }

    const downloadResult = await runAgentteamsConventionCommand(authPath, ['download'], spawnFn, log);
    if (downloadResult === null) {
      return;
    }

    if (downloadResult.exitCode === 0) {
      log.info('Convention sync completed', { authPath });
    } else if (downloadResult.exitCode !== null) {
      log.warn('Convention sync exited with non-zero code', {
        authPath,
        exitCode: downloadResult.exitCode,
        stderr: downloadResult.stderr.trim() || undefined,
      });
    }
  } catch (error) {
    log.warn('Convention sync failed', {
      authPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
