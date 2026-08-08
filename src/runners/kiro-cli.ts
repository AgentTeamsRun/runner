import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describeExecutableResolution, resolveExecutablePathWithPreference } from '../executable.js';
import { logger } from '../logger.js';
import { selectRunnerFailureMessage } from './failure-message.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';

const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

// Kiro CLI는 파이프(비-TTY)로 리다이렉트해도 stdout/stderr에 ANSI 이스케이프를 남기고,
// NO_COLOR=1이나 TERM=dumb으로도 완전히 제거되지 않는다(2026-08-08 실측). 구조화 출력
// 플래그가 없어 raw 텍스트를 그대로 흘려야 하므로, 최소한의 텍스트 정규화로 ANSI만
// 제거해 히스토리·실패 메시지에 제어 문자가 노출되지 않게 한다.
// CSI(`ESC [ … final`), OSC(`ESC ] … BEL|ST`), 그 밖의 2바이트 ESC 시퀀스를 모두 덮는다.
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-?]*[\u0020-\u002F]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/gu;

export const stripAnsiSequences = (value: string): string => value.replace(ANSI_ESCAPE_PATTERN, '');

/**
 * ANSI 제거를 청크 경계에 걸쳐서도 성립시키는 스트림 정규화기.
 *
 * `stripAnsiSequences`를 data 이벤트마다 개별 적용하면 `ESC[38;5;141m` 한 시퀀스가
 * 두 청크로 쪼개져 도착했을 때 양쪽 어디에도 매치되지 않아 raw 제어 문자가 그대로
 * 히스토리·실패 메시지에 남는다. 마지막 미완결 `ESC` 이후 꼬리를 다음 청크로 넘겨
 * 이어 붙인 뒤 판정한다.
 *
 * `\r`는 스피너 덮어쓰기 용도라 텍스트로는 의미가 없어 함께 제거한다.
 */
export const createAnsiStripper = (): { push: (chunk: string) => string; flush: () => string } => {
  // 가장 긴 ANSI 시퀀스(OSC)도 이 길이를 넘기 전에 종결자가 오므로, 그보다 길어진
  // 꼬리는 시퀀스가 아니라 그냥 ESC 문자가 섞인 텍스트로 보고 붙잡아 두지 않는다.
  const MAX_PENDING_ESCAPE = 64;
  const ESCAPE = '\u001B';
  let carry = '';

  return {
    push: (chunk: string): string => {
      const stripped = stripAnsiSequences(carry + chunk).replaceAll('\r', '');
      // 완결된 시퀀스는 이미 제거됐으므로, 남은 ESC는 아직 끝나지 않은 것뿐이다.
      const lastEscape = stripped.lastIndexOf(ESCAPE);
      if (lastEscape === -1 || stripped.length - lastEscape > MAX_PENDING_ESCAPE) {
        carry = '';
        return stripped.replaceAll(ESCAPE, '');
      }
      carry = stripped.slice(lastEscape);
      return stripped.slice(0, lastEscape);
    },
    // 미완결 ESC로 끝난 꼬리는 제어 문자라 최종 산출물에 넣지 않는다.
    flush: (): string => {
      carry = '';
      return '';
    },
  };
};

const normalizedModel = (model?: string | null): string => (typeof model === 'string' ? model.trim() : '');

/**
 * `--model`은 실측으로 확인된 플래그다(`kiro-cli chat --model <MODEL>`, 2026-08-08).
 * 잘못된 값은 exit 1과 함께 사용 가능 목록을 stderr에 출력하므로 조용한 폴백은 없다.
 * `default`는 모델 미지정을 뜻하는 플랫폼 내부 sentinel이라 전달하지 않는다
 * (Kiro 자체의 기본값은 `auto`이며, 그 값은 실제 모델 식별자이므로 그대로 전달한다).
 *
 * 프롬프트는 위치 인자라서 `-`로 시작하면 clap이 플래그로 오인해 usage 출력만 남기고
 * 종료한다(실측). 따라서 항상 `--` 구분자 뒤에 둔다.
 */
export const buildKiroCliArgs = (prompt: string, model?: string | null): string[] => {
  const selectedModel = normalizedModel(model);
  const modelArgs = selectedModel.length > 0 && selectedModel !== 'default' ? ['--model', selectedModel] : [];
  return ['chat', '--no-interactive', '--trust-all-tools', ...modelArgs, '--', prompt];
};

export const getKiroExecutablePreference = (isWindows: boolean): string[] =>
  isWindows ? ['kiro-cli.exe', 'kiro-cli'] : ['kiro-cli'];

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toKiroPowerShellEncodedCommand = (
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
    `& ${toPowerShellLiteral(resolvedExecutablePath)} 'chat' '--no-interactive' '--trust-all-tools'${modelSegment} '--' $promptText`,
  ].join('\r\n');

  return Buffer.from(scriptContent, 'utf16le').toString('base64');
};

const toOutputPreview = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_PREVIEW_MAX ? trimmed : `${trimmed.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

/**
 * Kiro CLI는 정상 실행 중에도 stderr로 신뢰 경고 배너와 종료 시 크레딧 요약
 * (`▸ Credits: N • Time: Ns`)을 보낸다. 그래서 "마지막 stderr 청크"를 그대로 실패
 * 사유로 쓰면 진짜 원인 대신 이런 진행 로그가 실릴 수 있다.
 *
 * 판정은 허용목록이 아니라 **차단목록**이다. 오류 문구를 열거하는 방식은 Kiro의
 * 대표 실패 문구 `Bedrock error message: The model returned the following errors: ...`
 * 처럼 줄 첫머리가 `error`가 아닌 형태를 통째로 놓치고, 그러면 크레딧 요약이 실패
 * 사유로 올라온다. Kiro는 구조화 출력이 없어 오류 형태를 미리 알 수 없으므로,
 * 알려진 진행 로그만 제외하고 나머지 stderr는 전부 오류 후보로 본다.
 */
const PROGRESS_ONLY_LINE_PATTERNS = [
  // 신뢰 배너: `--trust-all-tools`가 실행마다 출력한다.
  /all tools are now trusted/i,
  // 종료 요약: `▸ Credits: 0.03 • Time: 2s`
  /^[▸>*-]?\s*credits:\s/i,
  /^time:\s/i,
] as const;

const isProgressOnlyOutput = (text: string): boolean => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // 제어 문자만 남은 청크(빈 문자열)도 진행 로그로 본다.
  return lines.every((line) => PROGRESS_ONLY_LINE_PATTERNS.some((pattern) => pattern.test(line)));
};

const looksLikeErrorOutput = (text: string): boolean => text.trim().length > 0 && !isProgressOnlyOutput(text);

type KiroCliRunnerDependencies = {
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

const defaultDependencies: KiroCliRunnerDependencies = {
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

export class KiroCliRunner implements Runner {
  private readonly deps: KiroCliRunnerDependencies;

  constructor(dependencies: Partial<KiroCliRunnerDependencies> = {}) {
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
      'kiro-cli',
      getKiroExecutablePreference(isWindows),
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

    const args = buildKiroCliArgs(opts.prompt, opts.model);
    const executableInfo = this.deps.describeExecutableResolution('kiro-cli', {
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
              toKiroPowerShellEncodedCommand(resolvedExecutablePath, windowsPromptFilePath ?? '', opts.model),
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
    let lastErrorOutput = '';
    let firstErrorSignal = '';
    let outputText = '';
    const appendOutputText = (chunk: string): void => {
      if (outputText.length < OUTPUT_CAPTURE_MAX) {
        outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
      }
    };
    // stdout과 stderr는 서로 다른 스트림이라 ESC 캐리 버퍼도 각각 가져야 한다.
    const stdoutStripper = createAnsiStripper();
    const stderrStripper = createAnsiStripper();
    const idleTimer = { reset: (): void => {} };

    child.stdout?.on('data', (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      // Kiro는 구조화 출력이 없으므로 stdout은 최종 답변 본문 그대로다. ANSI만 벗겨 담는다.
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
        // 첫 오류를 고정한다. 원인 뒤에는 재시도 안내·요약 같은 후속 출력이 붙기 마련이라
        // "마지막 오류 청크"를 쓰면 진짜 원인이 다시 밀려난다.
        if (firstErrorSignal.length === 0 && looksLikeErrorOutput(output)) {
          firstErrorSignal = output;
        }
        idleTimer.reset();
        // Kiro CLI sends the trust banner, cursor control sequences, and the closing
        // `Credits: N • Time: Ns` summary to stderr on successful runs. Keep the raw stream
        // in the runner log, but do not expose it as an error or result.
        logger.info('Kiro CLI progress', { triggerId: opts.triggerId, pid: child.pid, output });
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
        appendOutputText(stdoutStripper.flush());
        // 마지막 청크가 미완결 ESC로 끝났더라도 최종 산출물에는 제어 문자가 남지 않는다.
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
            // 크레딧 요약 같은 진행 로그가 실패 사유를 덮지 않도록 첫 오류 청크를 우선한다.
            lastErrorOutput: firstErrorSignal || lastErrorOutput,
            lastOutput,
          }),
        });
      });
    });
  }
}
