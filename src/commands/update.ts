import { createRequire } from "node:module";
import { restartDaemon } from "../daemon-control.js";
import { runExecutableSync } from "../executable.js";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };

const packageName = "@agentteams/runner";

type UpdateDeps = {
  runExecutableSync?: typeof runExecutableSync;
  restartDaemon?: typeof restartDaemon;
  logger?: Pick<typeof logger, "info" | "warn">;
};

const getCurrentVersion = (): string => packageJson.version ?? "0.0.0";

const readLatestVersion = (
  deps: Pick<Required<UpdateDeps>, "runExecutableSync" | "logger">
): string | null => {
  try {
    const latestVersion = deps.runExecutableSync("npm", ["view", packageName, "version"]).trim();
    return latestVersion.length > 0 ? latestVersion : null;
  } catch (error) {
    deps.logger.warn("Failed to resolve latest AgentRunner version before update", {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

const normalizeInstallError = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("EACCES")
    || message.includes("EPERM")
    || message.toLowerCase().includes("permission denied")
  ) {
    return new Error(
      "Global npm install requires elevated permissions. Configure a user-level npm prefix or rerun the update with appropriate permissions."
    );
  }

  return new Error(`Failed to install the latest AgentRunner package: ${message}`);
};

export const runUpdateCommand = async (deps: UpdateDeps = {}): Promise<void> => {
  const resolvedRunExecutableSync = deps.runExecutableSync ?? runExecutableSync;
  const resolvedRestartDaemon = deps.restartDaemon ?? restartDaemon;
  const resolvedLogger = deps.logger ?? logger;

  const currentVersion = getCurrentVersion();
  const latestVersion = readLatestVersion({
    runExecutableSync: resolvedRunExecutableSync,
    logger: resolvedLogger
  });

  resolvedLogger.info("Updating AgentRunner package", {
    currentVersion,
    targetVersion: latestVersion ?? "latest"
  });

  try {
    resolvedRunExecutableSync("npm", ["install", "-g", `${packageName}@latest`]);
  } catch (error) {
    throw normalizeInstallError(error);
  }

  resolvedLogger.info("Package update completed", {
    version: latestVersion ?? "latest"
  });

  await resolvedRestartDaemon();

  resolvedLogger.info("AgentRunner update completed", {
    currentVersion,
    targetVersion: latestVersion ?? "latest"
  });
};
