import { createWriteStream } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import {
  describeExecutableResolution,
  resolveExecutablePathWithPreference,
  spawnExecutable
} from "../executable.js";
import { logger } from "../logger.js";
import { extractResultTextFromStreamJson } from "./claude-code.js";
import { createStreamJsonLineParser } from "./stream-json-parser.js";
import type { Runner, RunnerOptions, RunResult } from "./types.js";

const FORCE_KILL_AFTER_MS = 10_000;
const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;

export const buildAmpExecArgs = (prompt: string, model?: string | null): string[] => {
  const modeArgs = model ? ["--mode", model] : [];
  return ["--execute", prompt, "--dangerously-allow-all", "--stream-json-thinking", ...modeArgs];
};

const toPowerShellEncodedCommand = (resolvedExecutablePath: string, prompt: string, model?: string | null): string => {
  const modelSegment = model ? ` '--mode' '${model.replaceAll("'", "''")}'` : "";
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
    `& '${resolvedExecutablePath.replaceAll("'", "''")}' '--execute' $promptText '--dangerously-allow-all' '--stream-json-thinking'${modelSegment}`
  ].join("\r\n");

  return Buffer.from(scriptContent, "utf16le").toString("base64");
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

const terminateRunnerChild = (
  child: ReturnType<typeof spawn>,
  isWindows: boolean,
  triggerId: string,
  reason: "timeout" | "cancel"
) => {
  if (!child.pid) {
    return;
  }

  logger.warn(reason === "cancel" ? "Runner cancellation requested; sending SIGTERM" : "Runner timeout reached; sending SIGTERM", {
    triggerId,
    pid: child.pid
  });

  try {
    if (isWindows) {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // ignore
  }

  if (!isWindows) {
    setTimeout(() => {
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // ignore
      }
    }, FORCE_KILL_AFTER_MS);
  }
};

export class AmpCodeRunner implements Runner {
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
    await mkdir(dirname(logPath), { recursive: true });
    const isWindows = platform() === "win32";
    const resolvedExecutablePath = isWindows
      ? resolveExecutablePathWithPreference("amp", ["amp.cmd", "amp"])
      : resolveExecutablePathWithPreference("amp", ["amp"]);
    const windowsEncodedCommand = isWindows
      ? toPowerShellEncodedCommand(resolvedExecutablePath, opts.prompt, opts.model)
      : null;
    const executableInfo = describeExecutableResolution("amp", {
      platform: () => (isWindows ? "win32" : platform())
    });
    const ampArgs = buildAmpExecArgs(opts.prompt, opts.model);

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
      : spawnExecutable("amp", ampArgs, {
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

    const appendOutputText = (chunk: string) => {
      if (outputText.length >= OUTPUT_CAPTURE_MAX) {
        return;
      }

      outputText += chunk.slice(0, OUTPUT_CAPTURE_MAX - outputText.length);
    };

    const idleTimer = { reset: (): void => {} };
    const streamParser = createStreamJsonLineParser((entries) => {
      for (const entry of entries) {
        opts.onStdoutChunk?.(entry.message);
      }
    });
    child.stdout?.on("data", (chunk) => {
      const rawOutput = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      appendOutputText(rawOutput);
      streamParser.push(rawOutput);
      const output = toOutputPreview(rawOutput);
      if (output.length > 0) {
        lastOutput = output;
        idleTimer.reset();
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
        cleanup();
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

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        streamParser.flush();
        cleanup();
        logger.info("Runner process closed", {
          triggerId: opts.triggerId,
          pid: child.pid,
          exitCode: code,
          timedOut
        });

        if (timedOut) {
          const trimmedOutputText = outputText.trim();
          const resolvedOutputText = idleTimedOut && trimmedOutputText.length > 0
            ? extractResultTextFromStreamJson(outputText)
            : (trimmedOutputText || undefined);
          resolve({
            exitCode: 1,
            lastOutput,
            outputText: resolvedOutputText,
            errorMessage: idleTimedOut
              ? `Runner idle timed out after ${Math.round(opts.idleTimeoutMs / 60_000)}m of no output`
              : `Runner timed out after ${Math.round(opts.timeoutMs / 60_000)}m`
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
          errorMessage: code === 0 ? undefined : (lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`)
        });
      });
    });
  }
}
