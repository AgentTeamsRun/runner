import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DaemonConfigFile, RuntimeConfig } from "./types.js";

const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_RUNNER_CMD = "opencode";
const DEFAULT_API_URL = "http://localhost:3001";

export const getDaemonConfigPath = (): string => {
  return join(homedir(), ".agentteams", "daemon.json");
};

const parsePositiveInteger = (rawValue: string | undefined, fallback: number): number => {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

export const readDaemonConfigFile = async (): Promise<DaemonConfigFile | null> => {
  const path = getDaemonConfigPath();

  try {
    const content = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(content) as Partial<DaemonConfigFile>;

    if (!parsed.daemonToken || !parsed.apiUrl) {
      return null;
    }

    return {
      daemonToken: parsed.daemonToken,
      apiUrl: parsed.apiUrl
    };
  } catch {
    return null;
  }
};

export const writeDaemonConfigFile = async (config: DaemonConfigFile): Promise<string> => {
  const path = getDaemonConfigPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(config, null, 2), "utf8");
  return path;
};

export const resolveRuntimeConfig = async (): Promise<RuntimeConfig> => {
  const fileConfig = await readDaemonConfigFile();
  const daemonToken = process.env.AGENTTEAMS_DAEMON_TOKEN ?? fileConfig?.daemonToken;
  const apiUrl = process.env.AGENTTEAMS_API_URL ?? fileConfig?.apiUrl ?? DEFAULT_API_URL;

  if (!daemonToken || daemonToken.trim().length === 0) {
    throw new Error("Daemon token is missing. Run 'agentteams-daemon init --token <token>' first.");
  }

  return {
    daemonToken,
    apiUrl,
    pollingIntervalMs: parsePositiveInteger(process.env.POLLING_INTERVAL_MS, DEFAULT_POLLING_INTERVAL_MS),
    timeoutMs: parsePositiveInteger(process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    runnerCmd: process.env.RUNNER_CMD?.trim() || DEFAULT_RUNNER_CMD
  };
};

export const resolveApiUrlForInit = async (apiUrlArg?: string): Promise<string> => {
  if (apiUrlArg && apiUrlArg.trim().length > 0) {
    return apiUrlArg.trim();
  }

  const fileConfig = await readDaemonConfigFile();
  return process.env.AGENTTEAMS_API_URL ?? fileConfig?.apiUrl ?? DEFAULT_API_URL;
};
