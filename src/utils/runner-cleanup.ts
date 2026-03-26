import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";

const LOG_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

type CleanupDeps = {
  readdir?: typeof readdir;
  stat?: typeof stat;
  unlink?: typeof unlink;
  logger?: Pick<typeof logger, "info" | "warn">;
};

const purgeExpiredFiles = async (
  directory: string,
  ttlMs: number,
  deps: Required<Pick<CleanupDeps, "readdir" | "stat" | "unlink" | "logger">>
): Promise<number> => {
  let deleted = 0;
  let entries: string[];

  try {
    entries = await deps.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const now = Date.now();

  for (const entry of entries) {
    const filePath = join(directory, entry);
    try {
      const fileStat = await deps.stat(filePath);
      if (now - fileStat.mtimeMs > ttlMs) {
        await deps.unlink(filePath);
        deleted++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      deps.logger.warn("Failed to delete expired file", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return deleted;
};

export const runCleanup = async (authPath: string, deps: CleanupDeps = {}): Promise<void> => {
  const resolvedDeps = {
    readdir: deps.readdir ?? readdir,
    stat: deps.stat ?? stat,
    unlink: deps.unlink ?? unlink,
    logger: deps.logger ?? logger
  };
  const logDir = join(authPath, ".agentteams", "runner", "log");
  const historyDir = join(authPath, ".agentteams", "runner", "history");

  const [logDeleted, historyDeleted] = await Promise.all([
    purgeExpiredFiles(logDir, LOG_TTL_MS, resolvedDeps),
    purgeExpiredFiles(historyDir, HISTORY_TTL_MS, resolvedDeps)
  ]);

  resolvedDeps.logger.info("Runner cleanup completed", {
    authPath,
    logDeleted,
    historyDeleted
  });
};
