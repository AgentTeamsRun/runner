import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import {
  describeExecutableResolution,
  resolveExecutablePathWithPreference,
  spawnExecutable
} from "../executable.js";
import { logger } from "../logger.js";
import { setupCloseWatchdog, terminateRunnerChild } from "./process-control.js";
import type { Runner, RunnerOptions, RunResult } from "./types.js";

const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;
const DEFAULT_PRINT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const INTERNAL_LOG_POLL_MS = 1_000;
const INTERNAL_LOG_MAX_LINES_PER_TICK = 20;
const INTERNAL_LOG_MAX_LINE_LENGTH = 1_000;
const INTERNAL_LOG_MAX_FORWARDED_BYTES = 50_000;
const INTERNAL_LOG_PREFIX = "Antigravity internal log";

const toPrintTimeout = (timeoutMs: number = DEFAULT_PRINT_TIMEOUT_MS): string => {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
};

export const buildAntigravityExecArgs = (
  prompt: string,
  agentteamsDir: string,
  internalLogPath: string,
  timeoutMs?: number
): string[] => {
  return [
    "--dangerously-skip-permissions",
    "--add-dir",
    agentteamsDir,
    "--log-file",
    internalLogPath,
    "--print-timeout",
    toPrintTimeout(timeoutMs),
    "--print",
    prompt
  ];
};

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  prompt: string,
  agentteamsDir: string,
  internalLogPath: string,
  timeoutMs?: number
): string => {
  const scriptContent = [
    "$ErrorActionPreference = 'Stop'",
    "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $utf8NoBom",
    "[Console]::OutputEncoding = $utf8NoBom",
    "$OutputEncoding = $utf8NoBom",
    "chcp 65001 > $null",
    `$promptText = @'`,
    `${prompt.replaceAll("'@", "'@")}`,
    `'@`,
    `& ${toPowerShellLiteral(resolvedExecutablePath)} '--dangerously-skip-permissions' '--add-dir' ${toPowerShellLiteral(agentteamsDir)} '--log-file' ${toPowerShellLiteral(internalLogPath)} '--print-timeout' ${toPowerShellLiteral(toPrintTimeout(timeoutMs))} '--print' $promptText`
  ].join("\r\n");

  return Buffer.from(scriptContent, "utf16le").toString("base64");
};

export const sanitizeAntigravityInternalLogLine = (line: string): string => {
  return line
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|cookie|set-cookie)(["'\s:=]+)([^"',;\s]+)/gi, "$1$2[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
};

const toForwardedInternalLogLine = (line: string): string => {
  const sanitized = sanitizeAntigravityInternalLogLine(line.trim());
  const truncated = sanitized.length > INTERNAL_LOG_MAX_LINE_LENGTH
    ? `${sanitized.slice(0, INTERNAL_LOG_MAX_LINE_LENGTH)}...`
    : sanitized;
  return `[${INTERNAL_LOG_PREFIX}] ${truncated}`;
};

type InternalLogForwarderOptions = {
  logPath: string;
  triggerId: string;
  onLine: (line: string) => void;
  onActivity?: () => void;
  pollMs?: number;
};

export const createAntigravityInternalLogForwarder = ({
  logPath,
  triggerId,
  onLine,
  onActivity,
  pollMs = INTERNAL_LOG_POLL_MS
}: InternalLogForwarderOptions) => {
  let offset = 0;
  let pendingText = "";
  let forwardedBytes = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isReading = false;

  const forwardLines = (text: string, flush: boolean) => {
    const combined = pendingText + text;
    const parts = combined.split(/\r?\n/);
    pendingText = flush ? "" : (parts.pop() ?? "");
    const completeLines = flush ? parts : parts;

    let forwardedLines = 0;
    for (const line of completeLines) {
      if (forwardedLines >= INTERNAL_LOG_MAX_LINES_PER_TICK || forwardedBytes >= INTERNAL_LOG_MAX_FORWARDED_BYTES) {
        break;
      }

      if (line.trim().length === 0) {
        continue;
      }

      const output = toForwardedInternalLogLine(line);
      const allowedBytes = INTERNAL_LOG_MAX_FORWARDED_BYTES - forwardedBytes;
      const boundedOutput = Buffer.byteLength(output, "utf8") > allowedBytes
        ? output.slice(0, Math.max(0, allowedBytes))
        : output;

      if (boundedOutput.length === 0) {
        break;
      }

      forwardedBytes += Buffer.byteLength(boundedOutput, "utf8");
      forwardedLines += 1;
      onLine(boundedOutput);
      onActivity?.();
      logger.info("Runner antigravity internal log", {
        triggerId,
        output: boundedOutput
      });
    }
  };

  const readNewContent = async (flush = false): Promise<void> => {
    if (isReading) {
      return;
    }

    isReading = true;
    try {
      const fileStat = await stat(logPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          return null;
        }
        throw err;
      });

      if (!fileStat) {
        if (flush && pendingText.trim().length > 0) {
          forwardLines("", true);
        }
        return;
      }

      if (fileStat.size < offset) {
        offset = 0;
        pendingText = "";
      }

      if (fileStat.size > offset) {
        const length = fileStat.size - offset;
        const buffer = Buffer.alloc(length);
        const file = await open(logPath, "r");
        try {
          const result = await file.read(buffer, 0, length, offset);
          offset += result.bytesRead;
          forwardLines(buffer.subarray(0, result.bytesRead).toString("utf8"), flush);
        } finally {
          await file.close();
        }
      } else if (flush && pendingText.trim().length > 0) {
        forwardLines("", true);
      }
    } catch (err) {
      logger.warn("Runner antigravity internal log read error", {
        triggerId,
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      isReading = false;
    }
  };

  return {
    start: () => {
      if (intervalId) {
        return;
      }
      intervalId = setInterval(() => {
        void readNewContent(false);
      }, pollMs);
    },
    flush: () => readNewContent(true),
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
};

const toPromptPreview = (prompt: string): string => {
  if (prompt.length <= PROMPT_PREVIEW_MAX) {
    return prompt;
  }

  return `${prompt.slice(0, PROMPT_PREVIEW_MAX)}...`;
};

const toOutputPreview = (chunk: unknown): string => {
  const text = (typeof chunk === "string" ? chunk : String(chunk)).trim();
  if (text.length <= OUTPUT_PREVIEW_MAX) {
    return text;
  }

  return `${text.slice(0, OUTPUT_PREVIEW_MAX)}...`;
};

export class AntigravityRunner implements Runner {
  async run(opts: RunnerOptions): Promise<RunResult> {
    if (!opts.authPath || opts.authPath.trim().length === 0) {
      logger.error("authPath is missing for trigger");
      return {
        exitCode: 1,
        errorMessage: "authPath is missing for trigger"
      };
    }

    const cwd = opts.authPath;
    const logPath = join(cwd, ".agentteams", "runner", "log", `${opts.triggerId}.log`);
    const internalLogPath = join(cwd, ".agentteams", "runner", "log", `${opts.triggerId}.antigravity.log`);
    const agentteamsDir = join(cwd, ".agentteams");
    await mkdir(dirname(logPath), { recursive: true });
    const isWindows = platform() === "win32";
    const resolvedExecutablePath = isWindows
      ? resolveExecutablePathWithPreference("agy", ["agy.cmd", "agy"])
      : resolveExecutablePathWithPreference("agy", ["agy"]);
    const windowsEncodedCommand = isWindows
      ? toPowerShellEncodedCommand(resolvedExecutablePath, opts.prompt, agentteamsDir, internalLogPath, opts.timeoutMs)
      : null;
    const executableInfo = describeExecutableResolution("agy", {
      platform: () => (isWindows ? "win32" : platform())
    });
    const antigravityArgs = buildAntigravityExecArgs(opts.prompt, agentteamsDir, internalLogPath, opts.timeoutMs);

    if (opts.model && opts.model.trim().length > 0) {
      logger.warn("Antigravity CLI does not expose a verified launch-time model flag; model is ignored", {
        triggerId: opts.triggerId,
        model: opts.model
      });
    }

    logger.info("Runner prompt", {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptPreview: toPromptPreview(opts.prompt),
      requestedCommand: executableInfo.requestedCommand,
      resolvedExecutablePath,
      platform: executableInfo.platform,
      shell: executableInfo.shell,
      detached: isWindows ? false : true,
      windowsWrapper: isWindows ? "powershell.exe -EncodedCommand" : null
    });

    const child = isWindows
      ? spawn("powershell.exe", [
          "-NoLogo",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          windowsEncodedCommand ?? ""
        ], {
          cwd,
          detached: false,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            AGENTTEAMS_API_KEY: opts.apiKey,
            AGENTTEAMS_API_URL: opts.apiUrl,
            AGENTTEAMS_TEAM_ID: opts.teamId,
            AGENTTEAMS_PROJECT_ID: opts.projectId,
            AGENTTEAMS_AGENT_NAME: opts.agentConfigId
          }
        })
      : spawnExecutable("agy", antigravityArgs, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            AGENTTEAMS_API_KEY: opts.apiKey,
            AGENTTEAMS_API_URL: opts.apiUrl,
            AGENTTEAMS_TEAM_ID: opts.teamId,
            AGENTTEAMS_PROJECT_ID: opts.projectId,
            AGENTTEAMS_AGENT_NAME: opts.agentConfigId
          }
        });

    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.on("error", (err) => {
      logger.warn("Runner log stream error", { triggerId: opts.triggerId, error: err.message });
    });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    let lastOutput = "";
    let lastErrorOutput = "";
    let outputText = "";
    const internalLogForwarder = createAntigravityInternalLogForwarder({
      logPath: internalLogPath,
      triggerId: opts.triggerId,
      onLine: (line) => {
        lastOutput = line;
        opts.onStdoutChunk?.(line);
      },
      onActivity: () => idleTimer.reset()
    });

    const appendOutputText = (chunk: string) => {
      if (outputText.length >= OUTPUT_CAPTURE_MAX) {
        return;
      }

      outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
    };

    const idleTimer = { reset: (): void => {} };
    child.stdout?.on("data", (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      appendOutputText(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        idleTimer.reset();
        opts.onStdoutChunk?.(output);
        logger.info("Runner stdout", {
          triggerId: opts.triggerId,
          pid: child.pid,
          output
        });
      }
    });
    child.stderr?.on("data", (chunk) => {
      const output = toOutputPreview(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      if (output.length > 0) {
        lastOutput = output;
        lastErrorOutput = output;
        idleTimer.reset();
        opts.onStderrChunk?.(output);
        logger.warn("Runner stderr", {
          triggerId: opts.triggerId,
          pid: child.pid,
          output
        });
      }
    });

    logger.info("Runner started", {
      triggerId: opts.triggerId,
      cwd,
      logPath,
      internalLogPath,
      pid: child.pid
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
          logger.warn("Runner idle timeout reached; no output for configured idle period", {
            triggerId: opts.triggerId,
            idleTimeoutMs: opts.idleTimeoutMs
          });
          terminateRunnerChild(child, isWindows, opts.triggerId, "timeout");
        }, opts.idleTimeoutMs);
      };

      idleTimer.reset = () => {
        startIdleTimeout();
      };

      startIdleTimeout();
      internalLogForwarder.start();

      const cleanup = async () => {
        if (finished) {
          return;
        }

        finished = true;
        internalLogForwarder.stop();
        await internalLogForwarder.flush();
        if (idleTimeoutId) {
          clearTimeout(idleTimeoutId);
        }

        idleTimer.reset = () => {};
        logStream.end();
        if (opts.signal) {
          opts.signal.removeEventListener("abort", handleAbort);
        }
      };
      const handleAbort = () => {
        cancelled = true;
        terminateRunnerChild(child, isWindows, opts.triggerId, "cancel");
      };
      const timeoutId = setTimeout(() => {
        timedOut = true;
        terminateRunnerChild(child, isWindows, opts.triggerId, "timeout");
      }, opts.timeoutMs);

      if (opts.signal?.aborted) {
        handleAbort();
      } else if (opts.signal) {
        opts.signal.addEventListener("abort", handleAbort, { once: true });
      }

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        void cleanup().then(() => {
          logger.error("Runner process launch failed", {
            triggerId: opts.triggerId,
            error: error.message
          });
          resolve({
            exitCode: 1,
            lastOutput,
            outputText: outputText.trim() || undefined,
            errorMessage: error.message
          });
        });
      });

      const closeWatchdog = setupCloseWatchdog(child, opts.triggerId);

      child.on("close", (code) => {
        closeWatchdog.cancel();
        clearTimeout(timeoutId);
        void cleanup().then(() => {
          logger.info("Runner process closed", {
            triggerId: opts.triggerId,
            pid: child.pid,
            exitCode: code,
            timedOut
          });

          if (timedOut) {
            resolve({
              exitCode: 1,
              lastOutput,
              outputText: outputText.trim() || undefined,
              errorMessage: idleTimedOut
                ? `Runner idle timed out after ${Math.round(opts.idleTimeoutMs / 60_000)}m of no output`
                : `Runner fail-safe timed out after ${Math.round(opts.timeoutMs / 3_600_000)}h`
            });
            return;
          }

          if (cancelled) {
            resolve({
              exitCode: 1,
              cancelled: true,
              lastOutput,
              outputText: outputText.trim() || undefined,
              errorMessage: "Runner cancelled by user"
            });
            return;
          }

          resolve({
            exitCode: code ?? 1,
            lastOutput,
            outputText: outputText.trim() || undefined,
            errorMessage: code === 0
              ? undefined
              : lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`
          });
        });
      });
    });
  }
}
