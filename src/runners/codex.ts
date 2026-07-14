import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describeExecutableResolution, resolveExecutablePathWithPreference, spawnExecutable } from '../executable.js';
import { logger } from '../logger.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';

const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;
const DEFAULT_CODEX_SANDBOX_LEVEL = 'workspace-write';

export const resolveCodexSandboxLevel = (
  rawValue: string | undefined = process.env.CODEX_SANDBOX_LEVEL,
): 'workspace-write' | 'off' => {
  if (rawValue?.trim() === 'off') {
    return 'off';
  }

  return DEFAULT_CODEX_SANDBOX_LEVEL;
};

export const resolveCodexExecutionCwd = async (authPath: string): Promise<string> => {
  try {
    return await realpath(authPath);
  } catch {
    return authPath;
  }
};

// 요청 Effort를 Codex `-c model_reasoning_effort="<level>"` 오버라이드로 변환한다.
// 값은 서버가 이미 소문자로 검증·확정했으므로 daemon은 재검증하지 않고 그대로 전달한다.
const buildCodexEffortArgs = (effort?: string | null): string[] => {
  const normalized = typeof effort === 'string' ? effort.trim() : '';
  return normalized.length > 0 ? ['-c', `model_reasoning_effort="${normalized}"`] : [];
};

export const buildCodexExecArgs = (
  prompt: string,
  model?: string | null,
  sandboxLevel: 'workspace-write' | 'off' = resolveCodexSandboxLevel(),
  fastMode = false,
  effort?: string | null,
): string[] => {
  const baseArgs =
    sandboxLevel === 'off'
      ? ['-a', 'never', 'exec', '--dangerously-bypass-approvals-and-sandbox']
      : ['-a', 'never', 'exec', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
  const fastModeArgs = fastMode ? ['-c', 'features.fast_mode=true', '-c', 'service_tier="fast"'] : [];
  const effortArgs = buildCodexEffortArgs(effort);

  return model
    ? [...baseArgs, ...fastModeArgs, ...effortArgs, '--model', model, prompt]
    : [...baseArgs, ...fastModeArgs, ...effortArgs, prompt];
};

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

// Windows에서는 전체 prompt를 command line(-EncodedCommand)에 싣지 않고 UTF-8 임시 파일로 전달한다.
// prompt를 직접 인자로 넘기면 길이가 커질 때 `spawn ENAMETOOLONG`이 발생하므로,
// encoded command에는 prompt 파일 경로만 포함하고 PowerShell에서 UTF-8(no BOM)로 읽어 Codex stdin에 pipe한다.
export const toPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  model?: string | null,
  sandboxLevel: 'workspace-write' | 'off' = resolveCodexSandboxLevel(),
  fastMode = false,
  effort?: string | null,
): string => {
  const sandboxSegment =
    sandboxLevel === 'off'
      ? "'--dangerously-bypass-approvals-and-sandbox'"
      : "'-s' 'workspace-write' '-c' 'sandbox_workspace_write.network_access=true'";
  const modelSegment = model ? ` '--model' ${toPowerShellLiteral(model)}` : '';
  const fastModeSegment = fastMode ? " '-c' 'features.fast_mode=true' '-c' 'service_tier=\"fast\"'" : '';
  const normalizedEffort = typeof effort === 'string' ? effort.trim() : '';
  const effortSegment =
    normalizedEffort.length > 0 ? ` '-c' ${toPowerShellLiteral(`model_reasoning_effort="${normalizedEffort}"`)}` : '';
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'chcp 65001 > $null',
    `$promptText = [System.IO.File]::ReadAllText(${toPowerShellLiteral(promptFilePath)}, $utf8NoBom)`,
    `$promptText | & ${toPowerShellLiteral(resolvedExecutablePath)} '-a' 'never' 'exec' ${sandboxSegment}${fastModeSegment}${effortSegment}${modelSegment}`,
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

export class CodexRunner implements Runner {
  async run(opts: RunnerOptions): Promise<RunResult> {
    if (!opts.authPath || opts.authPath.trim().length === 0) {
      logger.error('authPath is missing for trigger');
      return {
        exitCode: 1,
        errorMessage: 'authPath is missing for trigger',
      };
    }

    const cwd = await resolveCodexExecutionCwd(opts.authPath);
    const logPath = join(cwd, '.agentteams', 'runner', 'log', `${opts.triggerId}.log`);
    await mkdir(dirname(logPath), { recursive: true });
    const isWindows = platform() === 'win32';
    const sandboxLevel = resolveCodexSandboxLevel();
    const resolvedExecutablePath = isWindows
      ? resolveExecutablePathWithPreference('codex', ['codex.cmd', 'codex'])
      : resolveExecutablePathWithPreference('codex', ['codex']);
    // Windows: 긴 prompt가 command line 길이 제한(spawn ENAMETOOLONG)에 걸리지 않도록 UTF-8 임시 파일로 전달한다.
    const windowsPromptFilePath = isWindows
      ? join(cwd, '.agentteams', 'runner', 'tmp', `${opts.triggerId}.prompt.txt`)
      : null;
    if (windowsPromptFilePath) {
      await mkdir(dirname(windowsPromptFilePath), { recursive: true });
      await writeFile(windowsPromptFilePath, opts.prompt, { encoding: 'utf8' });
    }
    const windowsEncodedCommand = windowsPromptFilePath
      ? toPowerShellEncodedCommand(
          resolvedExecutablePath,
          windowsPromptFilePath,
          opts.model,
          sandboxLevel,
          opts.fastMode === true,
          opts.effort,
        )
      : null;
    const codexArgs = buildCodexExecArgs(opts.prompt, opts.model, sandboxLevel, opts.fastMode === true, opts.effort);
    const executableInfo = describeExecutableResolution('codex', {
      platform: () => (isWindows ? 'win32' : platform()),
    });

    if (sandboxLevel === 'off') {
      logger.warn(
        'Codex sandbox is disabled via CODEX_SANDBOX_LEVEL=off; runner git writes and arbitrary commands are fully enabled',
        {
          triggerId: opts.triggerId,
        },
      );
    }

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
      sandboxLevel,
      fastMode: opts.fastMode === true,
      effort: typeof opts.effort === 'string' && opts.effort.trim().length > 0 ? opts.effort.trim() : null,
      authPath: opts.authPath,
      cwd,
    });

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
      : spawnExecutable('codex', codexArgs, {
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
    let outputText = '';

    const appendOutputText = (chunk: string) => {
      if (outputText.length >= OUTPUT_CAPTURE_MAX) {
        return;
      }

      outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
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
        logger.info('Runner stdout', {
          triggerId: opts.triggerId,
          pid: child.pid,
          output,
        });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const output = toOutputPreview(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
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

    // 정상 종료/실패 종료/취소 경로 모두에서 Windows prompt 임시 파일을 정리한다.
    // 삭제 실패는 runner 결과를 덮어쓰지 않고 warning 으로만 남긴다.
    const removeWindowsPromptFile = async () => {
      if (!windowsPromptFilePath) {
        return;
      }

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
        void removeWindowsPromptFile();
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
          outputText: outputText.trim() || undefined,
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
            outputText: outputText.trim() || undefined,
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
            outputText: outputText.trim() || undefined,
            errorMessage: 'Runner cancelled by user',
          });
          return;
        }

        resolve({
          exitCode: code ?? 1,
          lastOutput,
          outputText: outputText.trim() || undefined,
          errorMessage:
            code === 0 ? undefined : lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`,
        });
      });
    });
  }
}
