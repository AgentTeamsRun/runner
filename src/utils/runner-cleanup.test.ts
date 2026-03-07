import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { logger } from "../logger.js";
import { runCleanup } from "./runner-cleanup.js";

const makeAuthDir = async (): Promise<string> => {
  return await mkdtemp(join(tmpdir(), "runner-cleanup-test-"));
};

const touchAge = async (filePath: string, ageMs: number): Promise<void> => {
  const target = new Date(Date.now() - ageMs);
  await utimes(filePath, target, target);
};

test.afterEach(() => {
  mock.restoreAll();
});

test("runCleanup ignores missing log and history directories", async () => {
  const authPath = await makeAuthDir();

  try {
    await runCleanup(authPath);
  } finally {
    await rm(authPath, { recursive: true, force: true });
  }
});

test("runCleanup deletes only files older than each directory TTL", async () => {
  const authPath = await makeAuthDir();
  const logDir = join(authPath, ".agentteams", "runner", "log");
  const historyDir = join(authPath, ".agentteams", "runner", "history");

  try {
    await mkdir(logDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });

    const oldLog = join(logDir, "old.log");
    const freshLog = join(logDir, "fresh.log");
    const oldHistory = join(historyDir, "old.md");
    const freshHistory = join(historyDir, "fresh.md");

    await writeFile(oldLog, "old");
    await writeFile(freshLog, "fresh");
    await writeFile(oldHistory, "old");
    await writeFile(freshHistory, "fresh");

    await touchAge(oldLog, 2 * 24 * 60 * 60 * 1000);
    await touchAge(freshLog, 12 * 60 * 60 * 1000);
    await touchAge(oldHistory, 4 * 24 * 60 * 60 * 1000);
    await touchAge(freshHistory, 2 * 24 * 60 * 60 * 1000);

    await runCleanup(authPath);

    await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(oldLog)));
    await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(oldHistory)));
    await import("node:fs/promises").then(async ({ stat }) => {
      await stat(freshLog);
      await stat(freshHistory);
    });
  } finally {
    await rm(authPath, { recursive: true, force: true });
  }
});

test("runCleanup logs a warning and continues when an expired file cannot be deleted", async () => {
  const authPath = await makeAuthDir();
  const logDir = join(authPath, ".agentteams", "runner", "log");
  const historyDir = join(authPath, ".agentteams", "runner", "history");
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  mock.method(logger, "warn", (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta });
  });

  try {
    await mkdir(logDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });

    const lockedFile = join(logDir, "locked.log");
    const historyFile = join(historyDir, "history.md");

    await writeFile(lockedFile, "locked");
    await writeFile(historyFile, "history");
    await touchAge(lockedFile, 2 * 24 * 60 * 60 * 1000);
    await touchAge(historyFile, 4 * 24 * 60 * 60 * 1000);

    await import("node:fs/promises").then(({ chmod }) => chmod(logDir, 0o500));

    try {
      await runCleanup(authPath);
    } finally {
      await import("node:fs/promises").then(({ chmod }) => chmod(logDir, 0o700));
    }

    assert.equal(warnings.length >= 1, true);
    await import("node:fs/promises").then(async ({ stat }) => {
      await stat(lockedFile);
      await assert.rejects(() => stat(historyFile));
    });
  } finally {
    await rm(authPath, { recursive: true, force: true });
  }
});
