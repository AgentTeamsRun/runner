import { spawn } from "node:child_process";
import { logger } from "../logger.js";

type ConventionSyncDeps = {
  spawn?: typeof spawn;
  logger?: Pick<typeof logger, "info" | "warn">;
};

export const runConventionSync = async (authPath: string, deps: ConventionSyncDeps = {}): Promise<void> => {
  const log = deps.logger ?? logger;
  const spawnFn = deps.spawn ?? spawn;

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawnFn("agentteams", ["convention", "download"], {
        cwd: authPath,
        shell: true,
        stdio: "ignore",
        windowsHide: true,
      });

      child.on("error", (err) => {
        log.warn("Convention sync spawn error", {
          authPath,
          error: err.message,
        });
        resolve(null);
      });

      child.on("close", (code) => {
        resolve(code);
      });
    });

    if (exitCode === 0) {
      log.info("Convention sync completed", { authPath });
    } else if (exitCode !== null) {
      log.warn("Convention sync exited with non-zero code", {
        authPath,
        exitCode,
      });
    }
  } catch (error) {
    log.warn("Convention sync failed", {
      authPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
