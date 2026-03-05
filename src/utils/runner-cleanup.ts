import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";

const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const purgeExpiredFiles = async (directory: string, ttlMs: number): Promise<number> => {
  let deleted = 0;
  let entries: string[];

  try {
    entries = await readdir(directory);
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
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs > ttlMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      logger.warn("Failed to delete expired file", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return deleted;
};

export const runCleanup = async (authPath: string): Promise<void> => {
  const logDir = join(authPath, ".agentteams", "runner", "log");
  const historyDir = join(authPath, ".agentteams", "runner", "history");

  const [logDeleted, historyDeleted] = await Promise.all([
    purgeExpiredFiles(logDir, LOG_TTL_MS),
    purgeExpiredFiles(historyDir, HISTORY_TTL_MS)
  ]);

  logger.info("Runner cleanup completed", {
    authPath,
    logDeleted,
    historyDeleted
  });
};
