import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import type { Runner, RunnerOptions, RunResult } from "./types.js";

const FORCE_KILL_AFTER_MS = 10_000;
const PROMPT_PREVIEW_MAX = 500;
const OUTPUT_PREVIEW_MAX = 400;

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

export class OpenCodeRunner implements Runner {
  constructor(private readonly runnerCmd: string = "opencode") {}

  async run(opts: RunnerOptions): Promise<RunResult> {
    if (!opts.authPath || opts.authPath.trim().length === 0) {
      logger.error("authPath is missing for trigger");
      return {
        exitCode: 1,
        errorMessage: "authPath is missing for trigger"
      };
    }

    const cwd = opts.authPath;
    const logPath = join(cwd, ".agentteams", "runner-log", `${opts.triggerId}.log`);
    await mkdir(dirname(logPath), { recursive: true });

    logger.info("Runner prompt", {
      triggerId: opts.triggerId,
      promptLength: opts.prompt.length,
      promptPreview: toPromptPreview(opts.prompt)
    });

    const child = spawn(this.runnerCmd, ["run", opts.prompt], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENTTEAMS_API_KEY: opts.apiKey,
        AGENTTEAMS_API_URL: opts.apiUrl,
        AGENTTEAMS_AGENT_NAME: opts.agentConfigId
      }
    });

    const logStream = createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    let lastOutput = "";
    let lastErrorOutput = "";

    child.stdout?.on("data", (chunk) => {
      const output = toOutputPreview(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      if (output.length > 0) {
        lastOutput = output;
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

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;
        logStream.end();
      };

      const timeoutId = setTimeout(() => {
        timedOut = true;

        if (!child.pid) {
          return;
        }

        logger.warn("Runner timeout reached; sending SIGTERM", {
          triggerId: opts.triggerId,
          pid: child.pid,
          timeoutMs: opts.timeoutMs
        });

        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // ignore
        }

        setTimeout(() => {
          if (!finished && child.pid) {
            logger.warn("Runner still alive after SIGTERM; sending SIGKILL", {
              triggerId: opts.triggerId,
              pid: child.pid
            });

            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // ignore
            }
          }
        }, FORCE_KILL_AFTER_MS);
      }, opts.timeoutMs);

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
            errorMessage: `Runner timed out after ${opts.timeoutMs}ms`
          });
          return;
        }

        resolve({
          exitCode: code ?? 1,
          lastOutput,
          errorMessage: code === 0 ? undefined : (lastErrorOutput || lastOutput || `Runner exited with code ${code ?? 1}`)
        });
      });
    });
  }
}
