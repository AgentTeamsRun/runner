import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describeExecutableResolution, resolveExecutablePathWithPreference, spawnExecutable } from '../executable.js';
import { logger } from '../logger.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';

const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

export const buildCopilotCliArgs = (prompt: string, model?: string | null): string[] => {
  const modelArgs = model && model !== 'default' ? ['--model', model] : [];
  return ['-p', prompt, '--allow-all', '--no-ask-user', ...modelArgs];
};

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  model?: string | null,
): string => {
  const modelSegment = model && model !== 'default' ? ` '--model' ${toPowerShellLiteral(model)}` : '';
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'chcp 65001 > $null',
    `$promptText = [System.IO.File]::ReadAllText(${toPowerShellLiteral(promptFilePath)}, $utf8NoBom)`,
    `& ${toPowerShellLiteral(resolvedExecutablePath)} '-p' $promptText '--allow-all' '--no-ask-user'${modelSegment}`,
  ].join('\r\n');

  return Buffer.from(scriptContent, 'utf16le').toString('base64');
};

const toPromptPreview = (prompt: string): string =>
  prompt.length <= PROMPT_PREVIEW_MAX ? prompt : `${prompt.slice(0, PROMPT_PREVIEW_MAX)}...`;

const toOutputPreview = (chunk: unknown): string => {
  const text = (typeof chunk === 'string' ? chunk : String(chunk)).trim();
  return text.length <= OUTPUT_PREVIEW_MAX ? text : `${text.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

export class CopilotCliRunner implements Runner {
  async run(opts: RunnerOptions): Promise<RunResult> {
    if (!opts.authPath || opts.authPath.trim().length === 0) {
      logger.error('authPath is missing for trigger');
      return { exitCode: 1, errorMessage: 'authPath is missing for trigger' };
    }

    const cwd = opts.authPath;
    const logPath = join(cwd, '.agentteams', 'runner', 'log', `${opts.triggerId}.log`);
    await mkdir(dirname(logPath), { recursive: true });
    const isWindows = platform() === 'win32';
    const resolvedExecutablePath = isWindows
      ? resolveExecutablePathWithPreference('copilot', ['copilot.cmd', 'copilot'])
      : resolveExecutablePathWithPreference('copilot', ['copilot']);
    // Windows에서는 prompt를 PowerShell 코드에 넣지 않는다. here-string 경계를 탈출한 prompt가
    // Runner 계정으로 실행되는 것을 막고, 긴 prompt의 command-line 길이 제한도 피한다.
    const windowsPromptFilePath = isWindows
      ? join(cwd, '.agentteams', 'runner', 'tmp', `${opts.triggerId}.prompt.txt`)
      : null;
    if (windowsPromptFilePath) {
      await mkdir(dirname(windowsPromptFilePath), { recursive: true });
      await writeFile(windowsPromptFilePath, opts.prompt, { encoding: 'utf8' });
    }
    const windowsEncodedCommand = windowsPromptFilePath
      ? toPowerShellEncodedCommand(resolvedExecutablePath, windowsPromptFilePath, opts.model)
      : null;
    const executableInfo = describeExecutableResolution('copilot', {
      platform: () => (isWindows ? 'win32' : platform()),
    });
    const args = buildCopilotCliArgs(opts.prompt, opts.model);

    logger.info('Runner prompt', {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptPreview: toPromptPreview(opts.prompt),
      requestedCommand: executableInfo.requestedCommand,
      resolvedExecutablePath,
      platform: executableInfo.platform,
      shell: executableInfo.shell,
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
    const child = isWindows
      ? spawn(
          'powershell.exe',
          ['-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', windowsEncodedCommand ?? ''],
          { cwd, detached: false, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env },
        )
      : spawnExecutable('copilot', args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });

    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (error) =>
      logger.warn('Runner log stream error', { triggerId: opts.triggerId, error: error.message }),
    );
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    let lastOutput = '';
    let lastErrorOutput = '';
    let outputText = '';
    const appendOutputText = (chunk: string) => {
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
      appendOutputText(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        lastErrorOutput = output;
        idleTimer.reset();
        opts.onStderrChunk?.(output);
        logger.warn('Runner stderr', { triggerId: opts.triggerId, pid: child.pid, output });
      }
    });

    logger.info('Runner started', { triggerId: opts.triggerId, cwd, logPath, pid: child.pid });

    const removeWindowsPromptFile = async () => {
      if (!windowsPromptFilePath) return;

      try {
        await rm(windowsPromptFilePath, { force: true });
      } catch (error) {
        logger.warn('Failed to remove Windows prompt temp file', {
          triggerId: opts.triggerId,
          promptFilePath: windowsPromptFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    return await new Promise<RunResult>((resolve) => {
      let finished = false;
      let timedOut = false;
      let idleTimedOut = false;
      let cancelled = false;
      let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const startIdleTimeout = () => {
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
        idleTimeoutId = setTimeout(() => {
          idleTimedOut = true;
          timedOut = true;
          logger.warn('Runner idle timeout reached; no output for configured idle period', {
            triggerId: opts.triggerId,
            idleTimeoutMs: opts.idleTimeoutMs,
          });
          terminateRunnerChild(child, isWindows, opts.triggerId, 'timeout');
        }, opts.idleTimeoutMs);
      };
      idleTimer.reset = startIdleTimeout;
      startIdleTimeout();

      const handleAbort = () => {
        cancelled = true;
        terminateRunnerChild(child, isWindows, opts.triggerId, 'cancel');
      };
      const cleanup = () => {
        if (finished) return;
        finished = true;
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
        idleTimer.reset = (): void => {};
        logStream.end();
        void removeWindowsPromptFile();
        if (opts.signal) opts.signal.removeEventListener('abort', handleAbort);
      };
      const timeoutId = setTimeout(() => {
        timedOut = true;
        terminateRunnerChild(child, isWindows, opts.triggerId, 'timeout');
      }, opts.timeoutMs);

      if (opts.signal?.aborted) handleAbort();
      else if (opts.signal) opts.signal.addEventListener('abort', handleAbort, { once: true });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        cleanup();
        logger.error('Runner process launch failed', { triggerId: opts.triggerId, error: error.message });
        resolve({ exitCode: 1, lastOutput, outputText: outputText.trim() || undefined, errorMessage: error.message });
      });

      const closeWatchdog = setupCloseWatchdog(child, opts.triggerId);
      child.on('close', (code) => {
        closeWatchdog.cancel();
        clearTimeout(timeoutId);
        cleanup();
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
          errorMessage:
            code === 0 ? undefined : lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`,
        });
      });
    });
  }
}
