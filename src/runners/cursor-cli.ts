import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describeExecutableResolution, resolveExecutablePath } from '../executable.js';
import { logger } from '../logger.js';
import { extractResultTextFromStreamJson } from './claude-code.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import { createCursorStreamJsonLineParser, createResultLineCapturer } from './stream-json-parser.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';

const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

const normalizedModel = (model?: string | null): string => (typeof model === 'string' ? model.trim() : '');

export const buildCursorCliArgs = (prompt: string, model?: string | null): string[] => {
  const selectedModel = normalizedModel(model);
  const modelArgs = selectedModel.length > 0 && selectedModel !== 'default' ? ['--model', selectedModel] : [];
  return ['-p', '--force', '--output-format', 'stream-json', '--stream-partial-output', ...modelArgs, prompt];
};

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toCursorPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  model?: string | null,
): string => {
  const selectedModel = normalizedModel(model);
  const modelSegment =
    selectedModel.length > 0 && selectedModel !== 'default' ? ` '--model' ${toPowerShellLiteral(selectedModel)}` : '';
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'chcp 65001 > $null',
    `$promptText = [System.IO.File]::ReadAllText(${toPowerShellLiteral(promptFilePath)}, $utf8NoBom)`,
    `& ${toPowerShellLiteral(resolvedExecutablePath)} '-p' '--force' '--output-format' 'stream-json' '--stream-partial-output'${modelSegment} $promptText`,
  ].join('\r\n');

  return Buffer.from(scriptContent, 'utf16le').toString('base64');
};

const toOutputPreview = (chunk: unknown): string => {
  const text = (typeof chunk === 'string' ? chunk : String(chunk)).trim();
  return text.length <= OUTPUT_PREVIEW_MAX ? text : `${text.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

type CursorCliRunnerDependencies = {
  platform: typeof platform;
  resolveExecutablePath: typeof resolveExecutablePath;
  describeExecutableResolution: typeof describeExecutableResolution;
  spawn: typeof spawn;
  createWriteStream: typeof createWriteStream;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  rm: typeof rm;
  setupCloseWatchdog: typeof setupCloseWatchdog;
  terminateRunnerChild: typeof terminateRunnerChild;
};

const defaultDependencies: CursorCliRunnerDependencies = {
  platform,
  resolveExecutablePath,
  describeExecutableResolution,
  spawn,
  createWriteStream,
  mkdir,
  writeFile,
  rm,
  setupCloseWatchdog,
  terminateRunnerChild,
};

export class CursorCliRunner implements Runner {
  private readonly deps: CursorCliRunnerDependencies;

  constructor(dependencies: Partial<CursorCliRunnerDependencies> = {}) {
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
    const resolvedExecutablePath = this.deps.resolveExecutablePath('agent');
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

    const args = buildCursorCliArgs(opts.prompt, opts.model);
    const executableInfo = this.deps.describeExecutableResolution('agent', {
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

    let child: ReturnType<typeof spawn>;
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
              toCursorPowerShellEncodedCommand(resolvedExecutablePath, windowsPromptFilePath ?? '', opts.model),
            ],
            { cwd, detached: false, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env },
          )
        : this.deps.spawn(resolvedExecutablePath, args, {
            cwd,
            detached: true,
            shell: false,
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
    let lastErrorOutput = '';
    let outputText = '';
    const appendOutputText = (chunk: string): void => {
      if (outputText.length < OUTPUT_CAPTURE_MAX) {
        outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
      }
    };
    const resultLineCapturer = createResultLineCapturer();
    const finalizeOutputText = (): string | undefined => {
      const trimmed = outputText.trim();
      const resultLine = resultLineCapturer.get();
      if (resultLine && !trimmed.includes('"type":"result"')) {
        return trimmed.length > 0 ? `${trimmed}\n${resultLine}` : resultLine;
      }
      return trimmed || undefined;
    };
    const idleTimer = { reset: (): void => {} };
    const streamParser = createCursorStreamJsonLineParser(
      (entries) => {
        for (const entry of entries) opts.onStdoutChunk?.(entry.message);
      },
      { cwd },
    );

    child.stdout?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      appendOutputText(rawOutput);
      resultLineCapturer.push(rawOutput);
      streamParser.push(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        idleTimer.reset();
        logger.info('Runner stdout', { triggerId: opts.triggerId, pid: child.pid, output });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const output = toOutputPreview(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      if (output.length > 0) {
        lastOutput = output;
        lastErrorOutput = output;
        idleTimer.reset();
        opts.onStderrChunk?.(output);
        logger.warn('Runner stderr', { triggerId: opts.triggerId, pid: child.pid, output });
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
        resolve({ exitCode: 1, lastOutput, outputText: finalizeOutputText(), errorMessage: error.message });
      });

      const closeWatchdog = this.deps.setupCloseWatchdog(child, opts.triggerId);
      child.on('close', async (code) => {
        closeWatchdog.cancel();
        clearTimeout(timeoutId);
        streamParser.flush();
        resultLineCapturer.flush();
        await cleanup();
        logger.info('Runner process closed', { triggerId: opts.triggerId, pid: child.pid, exitCode: code, timedOut });

        const finalizedOutputText = finalizeOutputText();
        if (timedOut) {
          resolve({
            exitCode: 1,
            idleTimedOut,
            lastOutput,
            outputText:
              idleTimedOut && finalizedOutputText
                ? extractResultTextFromStreamJson(finalizedOutputText)
                : finalizedOutputText,
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
          errorMessage:
            code === 0 ? undefined : lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`,
        });
      });
    });
  }
}
