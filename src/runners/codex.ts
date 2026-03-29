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
import type { Runner, RunnerOptions, RunResult } from "./types.js";

const FORCE_KILL_AFTER_MS = 10_000;
const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;
const OUTPUT_CAPTURE_MAX = 200_000;
const DEFAULT_CODEX_SANDBOX_LEVEL = "workspace-write";

export const resolveCodexSandboxLevel = (rawValue: string | undefined = process.env.CODEX_SANDBOX_LEVEL): "workspace-write" | "off" => {
  if (rawValue?.trim() === "off") {
    return "off";
  }

  return DEFAULT_CODEX_SANDBOX_LEVEL;
};

export const buildCodexExecArgs = (
  prompt: string,
  model?: string | null,
  sandboxLevel: "workspace-write" | "off" = resolveCodexSandboxLevel()
): string[] => {
  const baseArgs =
    sandboxLevel === "off"
      ? ["-a", "never", "exec", "--dangerously-bypass-approvals-and-sandbox"]
      : ["-a", "never", "exec", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];

  return model ? [...baseArgs, "--model", model, prompt] : [...baseArgs, prompt];
};

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const toPowerShellEncodedCommand = (
  resolvedExecutablePath: string,
  prompt: string,
  model?: string | null,
  sandboxLevel: "workspace-write" | "off" = resolveCodexSandboxLevel()
): string => {
  const sandboxSegment =
    sandboxLevel === "off"
      ? "'--dangerously-bypass-approvals-and-sandbox'"
      : "'-s' 'workspace-write' '-c' 'sandbox_workspace_write.network_access=true'";
  const modelSegment = model ? ` '--model' ${toPowerShellLiteral(model)}` : "";
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
    `$promptText | & ${toPowerShellLiteral(resolvedExecutablePath)} '-a' 'never' 'exec' ${sandboxSegment}${modelSegment}`
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

  logger.warn(reason === "cancel" ? "Runner cancellation requested; sending SIGTERM" : "Runner fail-safe timeout reached; sending SIGTERM", {
    triggerId,
    pid: child.pid
  });

  try {
    if (isWindows) {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
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

export class CodexRunner implements Runner {
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
    const sandboxLevel = resolveCodexSandboxLevel();
    const resolvedExecutablePath = isWindows
      ? resolveExecutablePathWithPreference("codex", ["codex.cmd", "codex"])
      : resolveExecutablePathWithPreference("codex", ["codex"]);
    const windowsEncodedCommand = isWindows
      ? toPowerShellEncodedCommand(resolvedExecutablePath, opts.prompt, opts.model, sandboxLevel)
      : null;
    const codexArgs = buildCodexExecArgs(opts.prompt, opts.model, sandboxLevel);
    const executableInfo = describeExecutableResolution("codex", {
      platform: () => (isWindows ? "win32" : platform())
    });

    if (sandboxLevel === "off") {
      logger.warn("Codex sandbox is disabled via CODEX_SANDBOX_LEVEL=off; runner git writes and arbitrary commands are fully enabled", {
        triggerId: opts.triggerId
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
      windowsWrapper: isWindows ? "powershell.exe -EncodedCommand" : null,
      sandboxLevel
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
      : spawnExecutable("codex", codexArgs, {
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
        cleanup();
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
          errorMessage: code === 0 ? undefined : (lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`)
        });
      });
    });
  }
}
