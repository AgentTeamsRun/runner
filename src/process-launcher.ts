import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "./logger.js";
import type { RuntimeConfig, TriggerFinalStatus, TriggerRuntime } from "./types.js";

const FORCE_KILL_AFTER_MS = 10_000;

type LaunchInput = {
  triggerId: string;
  prompt: string;
  runtime: TriggerRuntime;
};

export class ProcessLauncher {
  private readonly activeProcesses = new Map<string, ChildProcess>();

  isRunning(agentConfigId: string): boolean {
    return this.activeProcesses.has(agentConfigId);
  }

  async launch(config: RuntimeConfig, input: LaunchInput): Promise<TriggerFinalStatus> {
    if (!input.runtime.authPath || input.runtime.authPath.trim().length === 0) {
      logger.error("authPath is missing for trigger", { triggerId: input.triggerId, agentConfigId: input.runtime.agentConfigId });
      return "FAILED";
    }

    if (this.isRunning(input.runtime.agentConfigId)) {
      logger.warn("Runner already active for agentConfigId; rejecting trigger", {
        triggerId: input.triggerId,
        agentConfigId: input.runtime.agentConfigId
      });
      return "REJECTED";
    }

    const cwd = input.runtime.authPath;
    const logPath = join(cwd, "daemon.log");
    await mkdir(dirname(logPath), { recursive: true });

    const child = spawn(config.runnerCmd, ["run", input.prompt], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENTTEAMS_API_KEY: input.runtime.apiKey,
        AGENTTEAMS_API_URL: config.apiUrl
      }
    });

    this.activeProcesses.set(input.runtime.agentConfigId, child);

    const logStream = createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    logger.info("Runner started", {
      triggerId: input.triggerId,
      agentConfigId: input.runtime.agentConfigId,
      cwd,
      pid: child.pid
    });

    return await new Promise<TriggerFinalStatus>((resolve) => {
      let finished = false;
      let timedOut = false;

      const cleanup = () => {
        if (finished) {
          return;
        }

        finished = true;
        this.activeProcesses.delete(input.runtime.agentConfigId);
        logStream.end();
      };

      const timeoutId = setTimeout(() => {
        timedOut = true;

        if (!child.pid) {
          return;
        }

        logger.warn("Runner timeout reached; sending SIGTERM", {
          triggerId: input.triggerId,
          agentConfigId: input.runtime.agentConfigId,
          pid: child.pid,
          timeoutMs: config.timeoutMs
        });

        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // ignore
        }

        setTimeout(() => {
          if (!finished && child.pid) {
            logger.warn("Runner still alive after SIGTERM; sending SIGKILL", {
              triggerId: input.triggerId,
              agentConfigId: input.runtime.agentConfigId,
              pid: child.pid
            });

            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // ignore
            }
          }
        }, FORCE_KILL_AFTER_MS);
      }, config.timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanup();
        logger.error("Runner process launch failed", {
          triggerId: input.triggerId,
          agentConfigId: input.runtime.agentConfigId,
          error: error.message
        });
        resolve("FAILED");
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        cleanup();

        if (timedOut) {
          resolve("FAILED");
          return;
        }

        resolve(code === 0 ? "DONE" : "FAILED");
      });
    });
  }
}
