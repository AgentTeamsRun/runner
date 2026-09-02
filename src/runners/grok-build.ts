import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand } from '../executable.js';
import { logger } from '../logger.js';
import { selectRunnerFailureMessage } from './failure-message.js';
import { setupCloseWatchdog, terminateRunnerChild } from './process-control.js';
import { createResultLineCapturer, createStreamJsonLineParser } from './stream-json-parser.js';
import type { Runner, RunnerOptions, RunResult } from './types.js';
import { buildRunnerChildEnv } from './session-env.js';
import { findGrokBuildExecutable, isGrokBuildExecutable } from './grok-build-identity.js';

const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

/**
 * Grok Build emits update notices on stderr and would otherwise self-update mid-run.
 * The CLI has no `--no-auto-update` flag (verified against grok 1.0.3); this env var is the
 * only documented suppression switch, and it keeps stdout reserved for the NDJSON stream.
 */
export const GROK_AUTOUPDATER_ENV = 'GROK_DISABLE_AUTOUPDATER';

const normalizedModel = (model?: string | null): string => (typeof model === 'string' ? model.trim() : '');

/**
 * Headless argument contract, measured against grok 1.0.3 (1a29d5bc12d4) on 2026-08-14.
 *
 * - The prompt is passed via `--prompt-file`, never `-p/--single`. A prompt whose first
 *   character is `-` (every runner prompt starts with a markdown bullet) makes clap abort
 *   with `error: unexpected argument '- ' found` and exit code 2 before the agent starts.
 * - `--output-format streaming-messages-json` produces the Anthropic Messages wire format,
 *   which the shared stream-json parser already understands. The native `streaming-json`
 *   alternative streams per-token `thought` deltas (63 lines vs 5 for the same prompt) and
 *   would need a dedicated parser for no gain.
 * - Permission bypass is `--permission-mode bypassPermissions`. The documented `--yolo`
 *   alias does not exist in this build.
 * - `--effort` is accepted and validates its levels (xhigh|high|medium|low), but the effect
 *   was not reproducible, so the runner does not pass it (see capabilities.ts).
 */
export const buildGrokBuildArgs = (promptFilePath: string, cwd: string, model?: string | null): string[] => {
  const selectedModel = normalizedModel(model);
  // `default` is the platform sentinel for "no model pinned"; Grok would reject it as an
  // unknown model id and exit 1.
  const modelArgs = selectedModel.length > 0 && selectedModel !== 'default' ? ['-m', selectedModel] : [];
  return [
    '--prompt-file',
    promptFilePath,
    '--cwd',
    cwd,
    '--output-format',
    'streaming-messages-json',
    '--permission-mode',
    'bypassPermissions',
    ...modelArgs,
  ];
};

/**
 * The official installer links the binary into `$GROK_HOME/bin` (default `~/.grok/bin`) and
 * `~/.local/bin`. An unrelated npm package (`@vibe-kit/grok-cli`) also installs a `grok`
 * binary, so name resolution alone is not enough — see `resolveGrokBuildExecutable` and the
 * identity check in `utils/engine-probe.ts`.
 */
export const getGrokExecutablePreference = (isWindows: boolean): string[] =>
  isWindows ? ['grok.exe', 'grok'] : ['grok'];

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toGrokBuildPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  promptFilePath: string,
  cwd: string,
  model?: string | null,
): string => {
  // The Windows path must carry the same structured-output flags as the POSIX argv, or the
  // runner would silently fall back to plain text there.
  const argSegment = buildGrokBuildArgs(promptFilePath, cwd, model)
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

const toOutputPreview = (chunk: unknown): string => {
  const text = (typeof chunk === 'string' ? chunk : String(chunk)).trim();
  return text.length <= OUTPUT_PREVIEW_MAX ? text : `${text.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

/**
 * Pulls the final answer out of the captured NDJSON so the history fallback shows prose
 * instead of a JSON dump. Mirrors the claude-code helper because the wire format is the same.
 */
export const extractGrokResultText = (outputText: string): string => {
  const trimmedOutput = outputText.trim();
  const lines = trimmedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"type":"result"')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as { type?: string; result?: unknown };
      if (parsed.type === 'result' && typeof parsed.result === 'string' && parsed.result.trim().length > 0) {
        return parsed.result.trim();
      }
    } catch {
      return trimmedOutput;
    }
  }

  return trimmedOutput;
};

type GrokBuildRunnerDependencies = {
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

const defaultDependencies: GrokBuildRunnerDependencies = {
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

export class GrokBuildRunner implements Runner {
  private readonly deps: GrokBuildRunnerDependencies;

  constructor(dependencies: Partial<GrokBuildRunnerDependencies> = {}) {
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
    const resolvedExecutablePath = await findGrokBuildExecutable(getGrokExecutablePreference(isWindows), {
      resolveExecutablePathsWithPreferenceAsync: this.deps.resolveExecutablePathsWithPreferenceAsync,
      runProbeCommand: this.deps.runProbeCommand,
      platform: this.deps.platform,
    });
    if (!resolvedExecutablePath) {
      const message =
        "Cannot find an official Grok Build executable. Every 'grok' candidate failed the 'Grok Build TUI' identity check.";
      logger.error('Grok Build executable identity check failed', { triggerId: opts.triggerId });
      return { exitCode: 1, errorMessage: message };
    }

    // Unlike other runners this file is not a Windows-only workaround: `--prompt-file` is the
    // only safe way to hand Grok a markdown prompt on every platform.
    const promptFilePath = join(cwd, '.agentteams', 'runner', 'tmp', `${opts.triggerId}.prompt.md`);
    await this.deps.mkdir(dirname(promptFilePath), { recursive: true });
    await this.deps.writeFile(promptFilePath, opts.prompt, { encoding: 'utf8' });

    const removePromptFile = async (): Promise<void> => {
      try {
        await this.deps.rm(promptFilePath, { force: true });
      } catch (error) {
        logger.warn('Failed to remove Grok Build prompt temp file', {
          triggerId: opts.triggerId,
          promptFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const args = buildGrokBuildArgs(promptFilePath, cwd, opts.model);
    logger.info('Runner prompt prepared', {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptFilePath,
      requestedCommand: 'grok',
      resolvedExecutablePath,
      platform: isWindows ? 'win32' : this.deps.platform(),
      shell: false,
      detached: !isWindows,
      windowsWrapper: isWindows ? 'powershell.exe -EncodedCommand' : null,
    });

    const env = buildRunnerChildEnv(process.env, opts);
    // AgentTeams never writes Grok credentials; this only stops the self-updater from
    // interleaving its notice with the NDJSON stream.
    env[GROK_AUTOUPDATER_ENV] = '1';

    // Re-check the exact resolved path immediately before spawn. Detection and candidate
    // selection can precede execution, so a replaced symlink/binary must fail closed before
    // it receives the prompt file path or permission-bypass arguments.
    if (
      !(await isGrokBuildExecutable(resolvedExecutablePath, {
        runProbeCommand: this.deps.runProbeCommand,
        platform: this.deps.platform,
      }))
    ) {
      await removePromptFile();
      const message = 'The resolved Grok Build executable changed identity before launch; execution was refused.';
      logger.error('Grok Build executable identity changed before launch', { triggerId: opts.triggerId });
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
              toGrokBuildPowerShellEncodedCommand(resolvedExecutablePath, promptFilePath, cwd, opts.model),
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
    let outputText = '';
    const appendOutputText = (chunk: string): void => {
      if (outputText.length < OUTPUT_CAPTURE_MAX) {
        outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
      }
    };

    // The head-capped capture can drop the terminal `result` line on long runs; keep it aside
    // so the history fallback still ends with the final answer.
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
    const streamParser = createStreamJsonLineParser(
      (entries) => {
        for (const entry of entries) {
          opts.onStdoutChunk?.(entry.message, entry.category, entry.toolName);
        }
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
        lastErrorOutput = output;
        idleTimer.reset();
        opts.onStderrChunk?.(output, 'STDERR');
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

        if (timedOut) {
          const finalizedOutputText = finalizeOutputText();
          const resolvedOutputText =
            idleTimedOut && finalizedOutputText ? extractGrokResultText(finalizedOutputText) : finalizedOutputText;
          resolve({
            exitCode: 1,
            timedOut,
            idleTimedOut,
            lastOutput,
            outputText: resolvedOutputText,
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
            outputText: finalizeOutputText(),
            errorMessage: 'Runner cancelled by user',
          });
          return;
        }
        resolve({
          exitCode: code ?? 1,
          lastOutput,
          outputText: finalizeOutputText(),
          errorMessage: selectRunnerFailureMessage({ exitCode: code, lastErrorOutput, lastOutput }),
        });
      });
    });
  }
}
