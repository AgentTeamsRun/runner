import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describeExecutableResolution, resolveExecutablePathWithPreference } from '../executable.js';
import { logger } from '../logger.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';

const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

const normalizedModel = (model?: string | null): string => (typeof model === 'string' ? model.trim() : '');

export const buildKimiCliArgs = (prompt: string, model?: string | null): string[] => {
  const selectedModel = normalizedModel(model);
  const modelArgs = selectedModel.length > 0 && selectedModel !== 'default' ? ['-m', selectedModel] : [];
  return ['-p', prompt, ...modelArgs];
};

export const getKimiExecutablePreference = (isWindows: boolean): string[] =>
  isWindows ? ['kimi.cmd', 'kimi'] : ['kimi'];

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toKimiPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  model?: string | null,
): string => {
  const selectedModel = normalizedModel(model);
  const modelSegment =
    selectedModel.length > 0 && selectedModel !== 'default' ? ` '-m' ${toPowerShellLiteral(selectedModel)}` : '';
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'chcp 65001 > $null',
    `$promptText = [System.IO.File]::ReadAllText(${toPowerShellLiteral(promptFilePath)}, $utf8NoBom)`,
    `& ${toPowerShellLiteral(resolvedExecutablePath)} '-p' $promptText${modelSegment}`,
  ].join('\r\n');

  return Buffer.from(scriptContent, 'utf16le').toString('base64');
};

const toOutputPreview = (chunk: unknown): string => {
  const text = (typeof chunk === 'string' ? chunk : String(chunk)).trim();
  return text.length <= OUTPUT_PREVIEW_MAX ? text : `${text.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

type KimiCliRunnerDependencies = {
  platform: typeof platform;
  resolveExecutablePathWithPreference: typeof resolveExecutablePathWithPreference;
  describeExecutableResolution: typeof describeExecutableResolution;
  spawn: typeof spawn;
  createWriteStream: typeof createWriteStream;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  rm: typeof rm;
  setupCloseWatchdog: typeof setupCloseWatchdog;
  terminateRunnerChild: typeof terminateRunnerChild;
};

const defaultDependencies: KimiCliRunnerDependencies = {
  platform,
  resolveExecutablePathWithPreference,
  describeExecutableResolution,
  spawn,
  createWriteStream,
  mkdir,
  writeFile,
  rm,
  setupCloseWatchdog,
  terminateRunnerChild,
};

export class KimiCliRunner implements Runner {
  private readonly deps: KimiCliRunnerDependencies;

  constructor(dependencies: Partial<KimiCliRunnerDependencies> = {}) {
    this.deps = { ...defaultDependencies, ...dependencies };
  }

  async run(opts: RunnerOptions): Promise<RunResult> {
    if (!opts.authPath || opts.authPath.trim().length === 0) {
      logger.error('authPath is missing for trigger');
      return { exitCode: 1, errorMessage: 'authPath is missing for trigger' };
    }

    const cwd = opts.authPath;
    const logPath = join(cwd, '.agentteams', 'runner', 'log', `${opts.triggerId}.log`);
    await this.deps.mkdir(dirname(logPath), { recursive: true });
    const isWindows = this.deps.platform() === 'win32';
    const resolvedExecutablePath = this.deps.resolveExecutablePathWithPreference(
      'kimi',
      getKimiExecutablePreference(isWindows),
    );
    const windowsPromptFilePath = isWindows
      ? join(cwd, '.agentteams', 'runner', 'tmp', `${opts.triggerId}.prompt.txt`)
      : null;

    if (windowsPromptFilePath) {
      await this.deps.mkdir(dirname(windowsPromptFilePath), { recursive: true });
      await this.deps.writeFile(windowsPromptFilePath, opts.prompt, { encoding: 'utf8' });
    }

    const removeWindowsPromptFile = async (): Promise<void> => {
      if (!windowsPromptFilePath) return;
      try {
        await this.deps.rm(windowsPromptFilePath, { force: true });
      } catch (error) {
        logger.warn('Failed to remove Windows prompt temp file', {
          triggerId: opts.triggerId,
          promptFilePath: windowsPromptFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const args = buildKimiCliArgs(opts.prompt, opts.model);
    const executableInfo = this.deps.describeExecutableResolution('kimi', {
      platform: () => (isWindows ? 'win32' : this.deps.platform()),
    });
    logger.info('Runner prompt prepared', {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      requestedCommand: executableInfo.requestedCommand,
      resolvedExecutablePath,
      platform: executableInfo.platform,
      shell: false,
      detached: !isWindows,
      windowsWrapper: isWindows ? 'powershell.exe -EncodedCommand' : null,
    });

    const env = {
      ...process.env,
      AGENTTEAMS_API_KEY: opts.apiKey,
      AGENTTEAMS_API_URL: opts.apiUrl,
      AGENTTEAMS_TEAM_ID: opts.teamId,
      AGENTTEAMS_PROJECT_ID: opts.projectId,
      AGENTTEAMS_AGENT_NAME: opts.agentConfigId,
    };

    let child: ChildProcess;
    try {
      child = isWindows
        ? this.deps.spawn(
            'powershell.exe',
            [
              '-NoLogo',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-EncodedCommand',
              toKimiPowerShellEncodedCommand(resolvedExecutablePath, windowsPromptFilePath ?? '', opts.model),
            ],
            { cwd, detached: false, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env },
          )
        : this.deps.spawn(resolvedExecutablePath, args, {
            cwd,
            detached: true,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
          });
    } catch (error) {
      await removeWindowsPromptFile();
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Runner process launch failed', { triggerId: opts.triggerId, error: message });
      return { exitCode: 1, errorMessage: message };
    }

    const logStream = this.deps.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (error) =>
      logger.warn('Runner log stream error', { triggerId: opts.triggerId, error: error.message }),
    );
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    let lastOutput = '';
    let outputText = '';
    const appendOutputText = (chunk: string): void => {
      if (outputText.length < OUTPUT_CAPTURE_MAX) {
        outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
      }
    };
    const idleTimer = { reset: (): void => {} };

    child.stdout?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      appendOutputText(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        idleTimer.reset();
        opts.onStdoutChunk?.(output);
        logger.info('Runner stdout', { triggerId: opts.triggerId, pid: child.pid, output });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        idleTimer.reset();
        // Kimi sends thinking/tool progress to stderr during successful print-mode runs.
        // Keep the raw stream in the runner log, but do not expose it as an error or result.
        logger.info('Kimi CLI progress', { triggerId: opts.triggerId, pid: child.pid, output });
      }
    });

    logger.info('Runner started', { triggerId: opts.triggerId, cwd, logPath, pid: child.pid });

    return await new Promise<RunResult>((resolve) => {
      let finished = false;
      let timedOut = false;
      let idleTimedOut = false;
      let cancelled = false;
      let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const startIdleTimeout = (): void => {
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
        idleTimeoutId = setTimeout(() => {
          idleTimedOut = true;
          timedOut = true;
          logger.warn('Runner idle timeout reached; no output for configured idle period', {
            triggerId: opts.triggerId,
            idleTimeoutMs: opts.idleTimeoutMs,
          });
          this.deps.terminateRunnerChild(child, isWindows, opts.triggerId, 'timeout');
        }, opts.idleTimeoutMs);
      };
      idleTimer.reset = startIdleTimeout;
      startIdleTimeout();

      const handleAbort = (): void => {
        cancelled = true;
        this.deps.terminateRunnerChild(child, isWindows, opts.triggerId, 'cancel');
      };
      const cleanup = async (): Promise<void> => {
        if (finished) return;
        finished = true;
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
        idleTimer.reset = (): void => {};
        logStream.end();
        await removeWindowsPromptFile();
        opts.signal?.removeEventListener('abort', handleAbort);
      };
      const timeoutId = setTimeout(() => {
        timedOut = true;
        this.deps.terminateRunnerChild(child, isWindows, opts.triggerId, 'timeout');
      }, opts.timeoutMs);

      if (opts.signal?.aborted) handleAbort();
      else opts.signal?.addEventListener('abort', handleAbort, { once: true });

      child.on('error', async (error) => {
        clearTimeout(timeoutId);
        await cleanup();
        logger.error('Runner process launch failed', { triggerId: opts.triggerId, error: error.message });
        resolve({ exitCode: 1, lastOutput, outputText: outputText.trim() || undefined, errorMessage: error.message });
      });

      const closeWatchdog = this.deps.setupCloseWatchdog(child, opts.triggerId);
      child.on('close', async (code) => {
        closeWatchdog.cancel();
        clearTimeout(timeoutId);
        await cleanup();
        logger.info('Runner process closed', { triggerId: opts.triggerId, pid: child.pid, exitCode: code, timedOut });
        const finalizedOutputText = outputText.trim() || undefined;

        if (timedOut) {
          resolve({
            exitCode: 1,
            idleTimedOut,
            lastOutput,
            outputText: finalizedOutputText,
            errorMessage: idleTimedOut
              ? `Runner idle timed out after ${Math.round(opts.idleTimeoutMs / 60_000)}m of no output`
              : `Runner fail-safe timed out after ${Math.round(opts.timeoutMs / 3_600_000)}h`,
          });
          return;
        }
        if (cancelled) {
          resolve({
            exitCode: 1,
            cancelled: true,
            lastOutput,
            outputText: finalizedOutputText,
            errorMessage: 'Runner cancelled by user',
          });
          return;
        }
        resolve({
          exitCode: code ?? 1,
          lastOutput,
          outputText: finalizedOutputText,
          errorMessage: code === 0 ? undefined : `Runner exited with code ${code ?? 1}`,
        });
      });
    });
  }
}
