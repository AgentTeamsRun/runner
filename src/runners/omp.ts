import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand } from '../executable.js';
import { logger } from '../logger.js';
import { selectRunnerFailureMessage } from './failure-message.js';
import { createAnsiStripper, stripAnsiSequences } from './kiro-cli.js';
import { findOmpExecutable, isOmpExecutable } from './omp-identity.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';
import { buildRunnerChildEnv } from './session-env.js';

const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

const normalizedModel = (model?: string | null): string => (typeof model === 'string' ? model.trim() : '');

const toPromptAttachArg = (promptFilePath: string): string => `@${promptFilePath}`;

/**
 * Headless argument contract, measured against omp/18.0.4 on 2026-08-24 (macOS arm64).
 *
 * - `-p/--print` is the oneshot flag. The prompt must not be a positional argument
 *   that starts with `-` — clap reports `Error: unknown flag` and exits 2. Every
 *   runner prompt starts with a markdown bullet, so the prompt is passed as `@file`.
 * - `--no-session` keeps the run from writing a reusable session next to the user's.
 * - Permission bypass is `--auto-approve` plus `--approval-mode yolo`. `--yolo` is
 *   accepted as an alias but is undocumented in `--help`; the long flags are the
 *   measured surface. Default config is already `tools.approvalMode=yolo`.
 * - `--cwd` sets the workspace. `--model` is consumed; unknown ids exit 1 with
 *   `Model "…" not found` (no silent fallback). `default` is the platform sentinel.
 * - 스트림 분리(2026-08-25 재실측, 로컬 OpenAI 호환 목 공급자로 성공 경로를 재현):
 *   성공하면 **stdout**에 최종 답변만 나오고(`OMP_STDOUT_PROBE_ANSWER_42\n`, exit 0),
 *   stderr에는 `Working...\n` 한 줄만 남는다. 실패하면 stdout은 0바이트이고 오류는
 *   전부 stderr로 나온다(exit 1). 그래서 stdout만 `outputText`/`onStdoutChunk`로
 *   흘리고 stderr는 진행 로그로 취급하는 이 배선이 맞다.
 * - 구조화 `--mode json`은 쓰지 않는다. NDJSON을 stdout으로 내기는 하지만 402 같은
 *   공급자 실패에도 **exit 0**을 돌려줘 종료 코드 기반 실패 판정이 무력화된다
 *   (2026-08-25 실측). 평문 모드는 실패를 exit 1로 정직하게 보고한다.
 */
export const buildOmpArgs = (promptFilePath: string, cwd: string, model?: string | null): string[] => {
  const selectedModel = normalizedModel(model);
  const modelArgs = selectedModel.length > 0 && selectedModel !== 'default' ? ['--model', selectedModel] : [];
  return [
    '-p',
    '--no-session',
    '--auto-approve',
    '--approval-mode',
    'yolo',
    '--cwd',
    cwd,
    toPromptAttachArg(promptFilePath),
    ...modelArgs,
  ];
};

export const getOmpExecutablePreference = (isWindows: boolean): string[] => (isWindows ? ['omp.exe', 'omp'] : ['omp']);

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toOmpPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  cwd: string,
  model?: string | null,
): string => {
  const argSegment = buildOmpArgs(promptFilePath, cwd, model)
    .map((arg) => ` ${toPowerShellLiteral(arg)}`)
    .join('');
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    'chcp 65001 > $null',
    `& ${toPowerShellLiteral(resolvedExecutablePath)}${argSegment}`,
  ].join('\r\n');

  return Buffer.from(scriptContent, 'utf16le').toString('base64');
};

const toOutputPreview = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_PREVIEW_MAX ? trimmed : `${trimmed.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

/**
 * omp는 성공·실패를 가리지 않고 stderr로 진행 로그를 먼저 쓴다. 판정은 Kiro와 같은
 * **차단목록**이다 — 오류 문구를 열거하면 형태를 모르는 공급자 오류를 통째로 놓친다.
 *
 * 여기 열거한 진행 문구는 omp/18.0.4 바이너리에서 실제로 stderr에 쓰는 것들이다
 * (2026-08-25 실측).
 * - `Working...`: 요청 시작 시점에 text 모드에서 한 번 쓴다. **성공 실행에서도 나온다.**
 *   이 줄을 걸러내지 않으면 첫 오류 신호로 latch돼 수 초 뒤 도착하는 진짜 사유
 *   (`402 Insufficient credits …`, `404 No endpoints found …`)를 덮어쓴다.
 * - `Still starting after <N>s — phase: …` + 뒤따르는 `logs: … PI_DEBUG_STARTUP …`:
 *   기동이 느릴 때 주기적으로 쓰는 2줄 안내.
 * - `Reading prompt from piped stdin …`: 러너는 stdin을 `ignore`로 두므로 도달하지
 *   않지만, 진행 문구지 오류가 아니라 함께 막아 둔다.
 */
const PROGRESS_ONLY_LINE_PATTERNS = [
  /^\(node:\d+\) Warning:/i,
  /NO_COLOR/i,
  /FORCE_COLOR/i,
  /trace-warnings/i,
  /^Use `omp --trace-warnings/i,
  /^Working\.\.\.$/,
  /^Still starting after \d+s/i,
  /^logs:\s.*PI_DEBUG_STARTUP/i,
  /^Reading prompt from piped stdin/i,
] as const;

const isProgressOnlyOutput = (text: string): boolean => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.every((line) => PROGRESS_ONLY_LINE_PATTERNS.some((pattern) => pattern.test(line)));
};

const looksLikeErrorOutput = (text: string): boolean => text.trim().length > 0 && !isProgressOnlyOutput(text);

type OmpRunnerDependencies = {
  platform: typeof platform;
  resolveExecutablePathsWithPreferenceAsync: typeof resolveExecutablePathsWithPreferenceAsync;
  runProbeCommand: typeof runProbeCommand;
  spawn: typeof spawn;
  createWriteStream: typeof createWriteStream;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  rm: typeof rm;
  setupCloseWatchdog: typeof setupCloseWatchdog;
  terminateRunnerChild: typeof terminateRunnerChild;
};

const defaultDependencies: OmpRunnerDependencies = {
  platform,
  resolveExecutablePathsWithPreferenceAsync,
  runProbeCommand,
  spawn,
  createWriteStream,
  mkdir,
  writeFile,
  rm,
  setupCloseWatchdog,
  terminateRunnerChild,
};

export class OmpRunner implements Runner {
  private readonly deps: OmpRunnerDependencies;

  constructor(dependencies: Partial<OmpRunnerDependencies> = {}) {
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
    const resolvedExecutablePath = await findOmpExecutable(getOmpExecutablePreference(isWindows), {
      resolveExecutablePathsWithPreferenceAsync: this.deps.resolveExecutablePathsWithPreferenceAsync,
      runProbeCommand: this.deps.runProbeCommand,
      platform: this.deps.platform,
    });
    if (!resolvedExecutablePath) {
      const message =
        "Cannot find an official Oh My Pi executable. Every 'omp' candidate failed the 'Oh My Pi' identity check.";
      logger.error('Oh My Pi executable identity check failed', { triggerId: opts.triggerId });
      return { exitCode: 1, errorMessage: message };
    }

    const promptFilePath = join(cwd, '.agentteams', 'runner', 'tmp', `${opts.triggerId}.prompt.md`);
    await this.deps.mkdir(dirname(promptFilePath), { recursive: true });
    await this.deps.writeFile(promptFilePath, opts.prompt, { encoding: 'utf8' });

    const removePromptFile = async (): Promise<void> => {
      try {
        await this.deps.rm(promptFilePath, { force: true });
      } catch (error) {
        logger.warn('Failed to remove Oh My Pi prompt temp file', {
          triggerId: opts.triggerId,
          promptFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const args = buildOmpArgs(promptFilePath, cwd, opts.model);
    logger.info('Runner prompt prepared', {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptFilePath,
      requestedCommand: 'omp',
      resolvedExecutablePath,
      platform: isWindows ? 'win32' : this.deps.platform(),
      shell: false,
      detached: !isWindows,
      windowsWrapper: isWindows ? 'powershell.exe -EncodedCommand' : null,
    });

    const env = buildRunnerChildEnv(process.env, opts);

    if (
      !(await isOmpExecutable(resolvedExecutablePath, {
        runProbeCommand: this.deps.runProbeCommand,
        platform: this.deps.platform,
      }))
    ) {
      await removePromptFile();
      const message = 'The resolved Oh My Pi executable changed identity before launch; execution was refused.';
      logger.error('Oh My Pi executable identity changed before launch', { triggerId: opts.triggerId });
      return { exitCode: 1, errorMessage: message };
    }

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
              toOmpPowerShellEncodedCommand(resolvedExecutablePath, promptFilePath, cwd, opts.model),
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
      await removePromptFile();
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
    let firstErrorSignal = '';
    let outputText = '';
    const appendOutputText = (chunk: string): void => {
      if (outputText.length < OUTPUT_CAPTURE_MAX) {
        outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
      }
    };
    const stdoutStripper = createAnsiStripper();
    const stderrStripper = createAnsiStripper();
    const idleTimer = { reset: (): void => {} };

    child.stdout?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const text = stdoutStripper.push(rawOutput);
      appendOutputText(text);
      const output = toOutputPreview(text);
      if (output.length > 0) {
        lastOutput = output;
        idleTimer.reset();
        opts.onStdoutChunk?.(output, 'TEXT');
        logger.info('Runner stdout', { triggerId: opts.triggerId, pid: child.pid, output });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const output = toOutputPreview(stderrStripper.push(rawOutput));
      if (output.length > 0) {
        lastErrorOutput = output;
        if (firstErrorSignal.length === 0 && looksLikeErrorOutput(output)) {
          firstErrorSignal = output;
        }
        idleTimer.reset();
        logger.info('Oh My Pi progress', { triggerId: opts.triggerId, pid: child.pid, output });
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
        await removePromptFile();
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
        appendOutputText(stdoutStripper.flush());
        const finalizedOutputText = stripAnsiSequences(outputText).trim() || undefined;

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
          errorMessage: selectRunnerFailureMessage({
            exitCode: code,
            lastErrorOutput: firstErrorSignal || lastErrorOutput,
            lastOutput,
          }),
        });
      });
    });
  }
}
