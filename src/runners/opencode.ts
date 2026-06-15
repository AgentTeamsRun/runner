import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describeExecutableResolution, resolveExecutablePathWithPreference, spawnExecutable } from '../executable.js';
import { logger } from '../logger.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';

const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

const toPowerShellEncodedCommand = (resolvedExecutablePath: string, prompt: string, model?: string | null): string => {
  const modelSegment = model ? ` '--model' '${model.replaceAll("'", "''")}'` : '';
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'chcp 65001 > $null',
    `$promptText = @'`,
    `${prompt.replaceAll("'@", "'@")}`,
    `'@`,
    `$promptText | & '${resolvedExecutablePath.replaceAll("'", "''")}' 'run'${modelSegment}`,
  ].join('\r\n');

  return Buffer.from(scriptContent, 'utf16le').toString('base64');
};

const toPromptPreview = (prompt: string): string => {
  if (prompt.length <= PROMPT_PREVIEW_MAX) {
    return prompt;
  }

  return `${prompt.slice(0, PROMPT_PREVIEW_MAX)}...`;
};

const toOutputPreview = (chunk: unknown): string => {
  const text = (typeof chunk === 'string' ? chunk : String(chunk)).trim();
  if (text.length <= OUTPUT_PREVIEW_MAX) {
    return text;
  }

  return `${text.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

// OpenCode `run`은 의미 있는 에이전트 출력을 stderr로 흘려보낸다(stdout은 비는 경우가 많다).
// 그래서 stdout만 누적하면 러너가 히스토리 파일을 안 썼을 때 stdout 폴백이 빈 값이 되어
// "DONE인데 히스토리가 빈" 레코드가 만들어진다(trigger-handler.reportHistory). 폴백이 작동하도록
// stderr도 outputText에 누적하되, Windows PowerShell이 진행 스트림을 stderr로 직렬화한
// CLIXML 노이즈(`#< CLIXML`, `<Objs ...>`)는 히스토리를 오염시키므로 제외한다.
export const isPowerShellClixmlNoise = (chunk: string): boolean => {
  const text = chunk.trimStart();
  return text.startsWith('#< CLIXML') || text.startsWith('<Objs ');
};

export type PowerShellClixmlFilterState = {
  isDiscardingClixml: boolean;
};

const CLIXML_END_MARKER = '</Objs>';

const findClixmlMarkerIndex = (chunk: string): number => {
  const markers = ['#< CLIXML', '<Objs '];
  let markerIndex = -1;

  for (const marker of markers) {
    let searchIndex = 0;
    while (searchIndex < chunk.length) {
      const candidateIndex = chunk.indexOf(marker, searchIndex);
      if (candidateIndex === -1) {
        break;
      }

      const lineStartIndex =
        Math.max(chunk.lastIndexOf('\n', candidateIndex - 1), chunk.lastIndexOf('\r', candidateIndex - 1)) + 1;
      const linePrefix = chunk.slice(lineStartIndex, candidateIndex);
      if (linePrefix.trim().length > 0) {
        searchIndex = candidateIndex + marker.length;
        continue;
      }

      markerIndex = markerIndex === -1 ? candidateIndex : Math.min(markerIndex, candidateIndex);
      break;
    }
  }

  return markerIndex;
};

export const filterPowerShellClixmlNoise = (chunk: string, state: PowerShellClixmlFilterState): string => {
  let remaining = chunk;
  let output = '';

  while (remaining.length > 0) {
    if (state.isDiscardingClixml) {
      const endIndex = remaining.indexOf(CLIXML_END_MARKER);
      if (endIndex === -1) {
        return output;
      }

      remaining = remaining.slice(endIndex + CLIXML_END_MARKER.length);
      state.isDiscardingClixml = false;
      continue;
    }

    const markerIndex = findClixmlMarkerIndex(remaining);
    if (markerIndex === -1) {
      output += remaining;
      break;
    }

    output += remaining.slice(0, markerIndex);
    remaining = remaining.slice(markerIndex);
    state.isDiscardingClixml = true;
  }

  return output;
};

export const createOpenCodeOutputCapture = () => {
  let outputText = '';
  const clixmlState: PowerShellClixmlFilterState = { isDiscardingClixml: false };

  const appendOutputText = (chunk: string) => {
    if (outputText.length >= OUTPUT_CAPTURE_MAX || chunk.length === 0) {
      return;
    }

    outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
  };

  return {
    appendStdout(chunk: string): void {
      appendOutputText(chunk);
    },
    appendStderr(chunk: string): void {
      appendOutputText(filterPowerShellClixmlNoise(chunk, clixmlState));
    },
    toResultOutputText(): string | undefined {
      return outputText.trim() || undefined;
    },
  };
};

export class OpenCodeRunner implements Runner {
  constructor(private readonly runnerCmd: string = 'opencode') {}

  async run(opts: RunnerOptions): Promise<RunResult> {
    if (!opts.authPath || opts.authPath.trim().length === 0) {
      logger.error('authPath is missing for trigger');
      return {
        exitCode: 1,
        errorMessage: 'authPath is missing for trigger',
      };
    }

    const cwd = opts.authPath;
    const logPath = join(cwd, '.agentteams', 'runner', 'log', `${opts.triggerId}.log`);
    await mkdir(dirname(logPath), { recursive: true });
    const isWindows = platform() === 'win32';
    const resolvedExecutablePath = isWindows
      ? resolveExecutablePathWithPreference(this.runnerCmd, [`${this.runnerCmd}.cmd`, this.runnerCmd])
      : resolveExecutablePathWithPreference(this.runnerCmd, [this.runnerCmd]);
    const windowsEncodedCommand = isWindows
      ? toPowerShellEncodedCommand(resolvedExecutablePath, opts.prompt, opts.model)
      : null;
    const executableInfo = describeExecutableResolution(this.runnerCmd, {
      platform: () => (isWindows ? 'win32' : platform()),
    });

    logger.info('Runner prompt', {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptPreview: toPromptPreview(opts.prompt),
      requestedCommand: executableInfo.requestedCommand,
      resolvedExecutablePath,
      platform: executableInfo.platform,
      shell: executableInfo.shell,
      detached: isWindows ? false : true,
      windowsWrapper: isWindows ? 'powershell.exe -EncodedCommand' : null,
    });

    const modelArgs = opts.model ? ['--model', opts.model] : [];
    const child = isWindows
      ? spawn(
          'powershell.exe',
          ['-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', windowsEncodedCommand ?? ''],
          {
            cwd,
            detached: false,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              AGENTTEAMS_API_KEY: opts.apiKey,
              AGENTTEAMS_API_URL: opts.apiUrl,
              AGENTTEAMS_TEAM_ID: opts.teamId,
              AGENTTEAMS_PROJECT_ID: opts.projectId,
              AGENTTEAMS_AGENT_NAME: opts.agentConfigId,
            },
          },
        )
      : spawnExecutable(this.runnerCmd, ['run', ...modelArgs, opts.prompt], {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            AGENTTEAMS_API_KEY: opts.apiKey,
            AGENTTEAMS_API_URL: opts.apiUrl,
            AGENTTEAMS_TEAM_ID: opts.teamId,
            AGENTTEAMS_PROJECT_ID: opts.projectId,
            AGENTTEAMS_AGENT_NAME: opts.agentConfigId,
          },
        });

    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (err) => {
      logger.warn('Runner log stream error', { triggerId: opts.triggerId, error: err.message });
    });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    let lastOutput = '';
    let lastErrorOutput = '';
    const outputCapture = createOpenCodeOutputCapture();

    const idleTimer = { reset: (): void => {} };
    child.stdout?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      outputCapture.appendStdout(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        idleTimer.reset();
        opts.onStdoutChunk?.(output);
        logger.info('Runner stdout', {
          triggerId: opts.triggerId,
          pid: child.pid,
          output,
        });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      outputCapture.appendStderr(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        lastErrorOutput = output;
        idleTimer.reset();
        opts.onStderrChunk?.(output);
        logger.warn('Runner stderr', {
          triggerId: opts.triggerId,
          pid: child.pid,
          output,
        });
      }
    });

    logger.info('Runner started', {
      triggerId: opts.triggerId,
      cwd,
      logPath,
      pid: child.pid,
    });

    return await new Promise<RunResult>((resolve) => {
      let finished = false;
      let timedOut = false;
      let idleTimedOut = false;
      let cancelled = false;

      let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const startIdleTimeout = () => {
        if (idleTimeoutId) {
          clearTimeout(idleTimeoutId);
        }

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

      idleTimer.reset = () => {
        startIdleTimeout();
      };

      startIdleTimeout();

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;
        if (idleTimeoutId) {
          clearTimeout(idleTimeoutId);
        }

        idleTimer.reset = () => {};
        logStream.end();
        if (opts.signal) {
          opts.signal.removeEventListener('abort', handleAbort);
        }
      };
      const handleAbort = () => {
        cancelled = true;
        terminateRunnerChild(child, isWindows, opts.triggerId, 'cancel');
      };
      const timeoutId = setTimeout(() => {
        timedOut = true;
        terminateRunnerChild(child, isWindows, opts.triggerId, 'timeout');
      }, opts.timeoutMs);

      if (opts.signal?.aborted) {
        handleAbort();
      } else if (opts.signal) {
        opts.signal.addEventListener('abort', handleAbort, { once: true });
      }

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        cleanup();
        logger.error('Runner process launch failed', {
          triggerId: opts.triggerId,
          error: error.message,
        });
        resolve({
          exitCode: 1,
          lastOutput,
          outputText: outputCapture.toResultOutputText(),
          errorMessage: error.message,
        });
      });

      const closeWatchdog = setupCloseWatchdog(child, opts.triggerId);

      child.on('close', (code) => {
        closeWatchdog.cancel();
        clearTimeout(timeoutId);
        cleanup();
        logger.info('Runner process closed', {
          triggerId: opts.triggerId,
          pid: child.pid,
          exitCode: code,
          timedOut,
        });

        if (timedOut) {
          resolve({
            exitCode: 1,
            idleTimedOut,
            lastOutput,
            outputText: outputCapture.toResultOutputText(),
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
            outputText: outputCapture.toResultOutputText(),
            errorMessage: 'Runner cancelled by user',
          });
          return;
        }

        resolve({
          exitCode: code ?? 1,
          lastOutput,
          outputText: outputCapture.toResultOutputText(),
          errorMessage:
            code === 0 ? undefined : lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`,
        });
      });
    });
  }
}
