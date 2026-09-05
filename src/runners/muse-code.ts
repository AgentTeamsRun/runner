import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand } from '../executable.js';
import { logger } from '../logger.js';
import { selectRunnerFailureMessage } from './failure-message.js';
import { createAnsiStripper } from './kiro-cli.js';
import { findMuseCodeExecutable, isMuseCodeExecutable } from './muse-code-identity.js';
import { createMuseCodeStreamConsumer } from './muse-code-json-parser.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';
import { buildRunnerChildEnv } from './session-env.js';

const OUTPUT_PREVIEW_MAX = 400;

const normalizedModel = (model?: string | null): string => (typeof model === 'string' ? model.trim() : '');

// muse 1.0.2 (2026-09-04): cwd가 workspace이며 프롬프트는 파일로 전달한다.
// 승인을 비대화형으로 설정하되 기본 샌드박스는 유지한다.
export const buildMuseCodeArgs = (promptFilePath: string, model?: string | null, effort?: string | null): string[] => {
  const selectedModel = normalizedModel(model);
  return [
    'exec',
    '--json',
    '--approval-mode',
    'never',
    '--prompt-file',
    promptFilePath,
    ...(selectedModel && selectedModel !== 'default' ? ['--model', selectedModel] : []),
    ...(effort?.trim() ? ['--reasoning-effort', effort.trim()] : []),
  ];
};

export const getMuseCodeExecutablePreference = (isWindows: boolean): string[] =>
  isWindows ? ['muse.exe', 'muse'] : ['muse'];

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toMuseCodePowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  model?: string | null,
  effort?: string | null,
): string => {
  const argSegment = buildMuseCodeArgs(promptFilePath, model, effort)
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

// 실측된 기동·종료 진단 문구는 실패 사유 후보에서 제외한다.
const PROGRESS_ONLY_LINE_PATTERNS = [/^muse: workspace root:/, /^run ended with /] as const;

const isProgressOnlyOutput = (text: string): boolean => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.every((line) => PROGRESS_ONLY_LINE_PATTERNS.some((pattern) => pattern.test(line)));
};

const looksLikeErrorOutput = (text: string): boolean => text.trim().length > 0 && !isProgressOnlyOutput(text);

type MuseCodeRunnerDependencies = {
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

const defaultDependencies: MuseCodeRunnerDependencies = {
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

export class MuseCodeRunner implements Runner {
  private readonly deps: MuseCodeRunnerDependencies;

  constructor(dependencies: Partial<MuseCodeRunnerDependencies> = {}) {
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
    const resolvedExecutablePath = await findMuseCodeExecutable(getMuseCodeExecutablePreference(isWindows), {
      resolveExecutablePathsWithPreferenceAsync: this.deps.resolveExecutablePathsWithPreferenceAsync,
      runProbeCommand: this.deps.runProbeCommand,
      platform: this.deps.platform,
    });
    if (!resolvedExecutablePath) {
      const message =
        "Cannot find an official Muse Code executable. Every 'muse' candidate failed the Muse Code identity check.";
      logger.error('Muse Code executable identity check failed', { triggerId: opts.triggerId });
      return { exitCode: 1, errorMessage: message };
    }

    const promptFilePath = join(cwd, '.agentteams', 'runner', 'tmp', `${opts.triggerId}.prompt.md`);
    await this.deps.mkdir(dirname(promptFilePath), { recursive: true });
    await this.deps.writeFile(promptFilePath, opts.prompt, { encoding: 'utf8' });

    const removePromptFile = async (): Promise<void> => {
      try {
        await this.deps.rm(promptFilePath, { force: true });
      } catch (error) {
        logger.warn('Failed to remove Muse Code prompt temp file', {
          triggerId: opts.triggerId,
          promptFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const args = buildMuseCodeArgs(promptFilePath, opts.model, opts.effort);
    logger.info('Runner prompt prepared', {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptFilePath,
      requestedCommand: 'muse',
      resolvedExecutablePath,
      platform: isWindows ? 'win32' : this.deps.platform(),
      shell: false,
      detached: !isWindows,
      windowsWrapper: isWindows ? 'powershell.exe -EncodedCommand' : null,
    });

    const env = buildRunnerChildEnv(process.env, opts);

    if (
      !(await isMuseCodeExecutable(resolvedExecutablePath, {
        runProbeCommand: this.deps.runProbeCommand,
        platform: this.deps.platform,
      }))
    ) {
      await removePromptFile();
      const message = 'The resolved Muse Code executable changed identity before launch; execution was refused.';
      logger.error('Muse Code executable identity changed before launch', { triggerId: opts.triggerId });
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
              toMuseCodePowerShellEncodedCommand(resolvedExecutablePath, promptFilePath, opts.model, opts.effort),
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
    let lastErrorSignal = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutStripper = createAnsiStripper();
    const stderrStripper = createAnsiStripper();
    const idleTimer = { reset: (): void => {} };
    // 각 NDJSON 라인을 한 번만 파싱해 라이브 로그와 결과 판정 양쪽에 전달한다.
    const streamConsumer = createMuseCodeStreamConsumer((entries) => {
      for (const entry of entries) {
        // 실패 사유 후보(lastOutput)는 모델이 쓴 텍스트로 한정한다. SYSTEM(verbose 원문 봉투)이나
        // TOOL 요약이 사유로 승격되면 사람이 읽을 수 없는 조각이 화면에 노출된다.
        if (entry.category === 'TEXT' || entry.category === 'RESULT') {
          lastOutput = toOutputPreview(entry.message);
        }
        opts.onStdoutChunk?.(entry.message, entry.category, entry.toolName);
      }
    });

    child.stdout?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk);
      const text = stdoutStripper.push(rawOutput);
      if (text.length === 0) {
        return;
      }
      streamConsumer.push(text);
      // 이벤트가 로그 엔트리로 정제되지 않는 구간(델타 연발)에도 살아 있다는 신호이므로,
      // 리셋은 정제 결과가 아니라 데이터 도착을 기준으로 한다.
      idleTimer.reset();
      logger.info('Runner stdout', { triggerId: opts.triggerId, pid: child.pid, output: toOutputPreview(text) });
    });
    child.stderr?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk);
      const output = toOutputPreview(stderrStripper.push(rawOutput));
      if (output.length > 0) {
        lastErrorOutput = output;
        // 진행 표시(`run ended with ...`)가 stderr 마지막에 찍혀 실제 오류를 가리므로, 진행 표시가 아닌
        // 가장 최근 청크를 사유로 쓴다. 첫 청크를 고정하면 초반의 무해한 경고가 사유가 된다.
        if (looksLikeErrorOutput(output)) {
          lastErrorSignal = output;
        }
        idleTimer.reset();
        opts.onStderrChunk?.(output, 'STDERR');
        logger.info('Muse Code progress', { triggerId: opts.triggerId, pid: child.pid, output });
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
        resolve({
          exitCode: 1,
          lastOutput,
          outputText: streamConsumer.getFinalText() ?? streamConsumer.getStreamedTextFallback() ?? undefined,
          errorMessage: error.message,
        });
      });

      const closeWatchdog = this.deps.setupCloseWatchdog(child, opts.triggerId);
      child.on('close', async (code) => {
        closeWatchdog.cancel();
        clearTimeout(timeoutId);
        await cleanup();
        logger.info('Runner process closed', { triggerId: opts.triggerId, pid: child.pid, exitCode: code, timedOut });
        streamConsumer.push(stdoutStripper.push(stdoutDecoder.end()));
        stdoutStripper.flush();
        // 라인 스캐너가 개행 없이 끝난 마지막 NDJSON 라인을 회수한다.
        streamConsumer.flush();
        const finalizedOutputText =
          streamConsumer.getFinalText() ?? streamConsumer.getStreamedTextFallback() ?? undefined;
        const streamFailureMessage = streamConsumer.getFailureMessage();

        if (timedOut) {
          resolve({
            exitCode: 1,
            timedOut,
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
        // 종단 실패 이벤트는 종료 코드와 무관하게 보존한다.
        if (streamFailureMessage) {
          resolve({
            exitCode: code && code !== 0 ? code : 1,
            lastOutput,
            outputText: finalizedOutputText,
            errorMessage: streamFailureMessage,
          });
          return;
        }
        resolve({
          exitCode: code ?? 1,
          lastOutput,
          outputText: finalizedOutputText,
          errorMessage: selectRunnerFailureMessage({
            exitCode: code,
            lastErrorOutput: lastErrorSignal || lastErrorOutput,
            lastOutput,
          }),
        });
      });
    });
  }
}
