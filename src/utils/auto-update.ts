import { createRequire } from "node:module";
import { runExecutableSync } from "../executable.js";
import { logger } from "../logger.js";
import type { PendingMeta } from "../types.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };

const CLI_PACKAGE = "@agentteams/cli";
const RUNNER_PACKAGE = "@agentteams/runner";

const COOLDOWN_MS = 60 * 60 * 1000; // 1시간

type AutoUpdateDeps = {
  runExecutableSync?: typeof runExecutableSync;
  logger?: Pick<typeof logger, "info" | "warn" | "error">;
  now?: () => number;
  onRunnerUpdated?: (version: string) => Promise<void>;
};

let lastCliUpdateAttempt = 0;
let lastRunnerUpdateAttempt = 0;
let lastSuccessfulRunnerVersion: string | null = null;
let lastNotifiedRunnerVersion: string | null = null;

const getCurrentRunnerVersion = (): string => packageJson.version ?? "0.0.0";

const getInstalledCliVersion = (deps: Pick<Required<AutoUpdateDeps>, "runExecutableSync" | "logger">): string | null => {
  try {
    const version = deps.runExecutableSync("npm", ["list", "-g", CLI_PACKAGE, "--depth=0", "--json"]);
    const parsed = JSON.parse(version) as { dependencies?: Record<string, { version?: string }> };
    return parsed.dependencies?.[CLI_PACKAGE]?.version ?? null;
  } catch {
    return null;
  }
};

const needsUpdate = (currentVersion: string | null, latestVersion: string | null): boolean => {
  if (!currentVersion || !latestVersion) return false;
  return currentVersion !== latestVersion;
};

const installPackage = (
  packageName: string,
  version: string,
  deps: Pick<Required<AutoUpdateDeps>, "runExecutableSync">
): void => {
  deps.runExecutableSync("npm", ["install", "-g", `${packageName}@${version}`]);
};

export const maybeAutoUpdate = async (
  meta: PendingMeta | undefined,
  deps: AutoUpdateDeps = {}
): Promise<{ cliUpdated: boolean; runnerUpdated: boolean }> => {
  if (!meta) return { cliUpdated: false, runnerUpdated: false };

  const resolvedRunExecutableSync = deps.runExecutableSync ?? runExecutableSync;
  const resolvedLogger = deps.logger ?? logger;
  const now = (deps.now ?? Date.now)();

  let cliUpdated = false;
  let runnerUpdated = false;

  // CLI 업데이트
  if (meta.cliLatestVersion && now - lastCliUpdateAttempt >= COOLDOWN_MS) {
    lastCliUpdateAttempt = now;
    const currentCliVersion = getInstalledCliVersion({
      runExecutableSync: resolvedRunExecutableSync,
      logger: resolvedLogger
    });

    if (needsUpdate(currentCliVersion, meta.cliLatestVersion)) {
      try {
        resolvedLogger.info("Auto-updating CLI", {
          currentVersion: currentCliVersion,
          targetVersion: meta.cliLatestVersion
        });
        installPackage(CLI_PACKAGE, meta.cliLatestVersion, {
          runExecutableSync: resolvedRunExecutableSync
        });
        cliUpdated = true;
        resolvedLogger.info("CLI auto-update completed", {
          version: meta.cliLatestVersion
        });
      } catch (error) {
        resolvedLogger.error("CLI auto-update failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // Runner 업데이트
  if (meta.runnerLatestVersion && now - lastRunnerUpdateAttempt >= COOLDOWN_MS) {
    lastRunnerUpdateAttempt = now;
    const currentRunnerVersion = getCurrentRunnerVersion();

    const isAlreadyInstalled = lastSuccessfulRunnerVersion === meta.runnerLatestVersion;

    if (!isAlreadyInstalled && needsUpdate(currentRunnerVersion, meta.runnerLatestVersion)) {
      try {
        resolvedLogger.info("Auto-updating Runner", {
          currentVersion: currentRunnerVersion,
          targetVersion: meta.runnerLatestVersion
        });
        installPackage(RUNNER_PACKAGE, meta.runnerLatestVersion, {
          runExecutableSync: resolvedRunExecutableSync
        });
        runnerUpdated = true;
        lastSuccessfulRunnerVersion = meta.runnerLatestVersion;
        resolvedLogger.info("Runner auto-update completed — restart required", {
          version: meta.runnerLatestVersion
        });
      } catch (error) {
        resolvedLogger.error("Runner auto-update failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

  }

  // Runner 알림: 설치 성공 후 알림 미완료 시 매 폴링마다 재시도
  if (meta.runnerLatestVersion && lastSuccessfulRunnerVersion === meta.runnerLatestVersion
    && lastNotifiedRunnerVersion !== meta.runnerLatestVersion && deps.onRunnerUpdated) {
    try {
      await deps.onRunnerUpdated(meta.runnerLatestVersion);
      lastNotifiedRunnerVersion = meta.runnerLatestVersion;
    } catch (notifyError) {
      resolvedLogger.error("Failed to notify runner update", {
        error: notifyError instanceof Error ? notifyError.message : String(notifyError)
      });
    }
  }

  return { cliUpdated, runnerUpdated };
};

/** 테스트용: 쿨다운 타이머 리셋 */
export const resetAutoUpdateState = (): void => {
  lastCliUpdateAttempt = 0;
  lastRunnerUpdateAttempt = 0;
  lastSuccessfulRunnerVersion = null;
  lastNotifiedRunnerVersion = null;
};

