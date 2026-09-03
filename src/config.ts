import { chmodSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';
import type { DaemonConfigFile, RuntimeConfig } from './types.js';

const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_POLLING_INTERVAL_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// 최근 30일 체인 노드 실측 최대가 29.0분이어서 정상 장기 작업을 끊지 않도록 30분을 보장한다.
const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;
const DEFAULT_RUNNER_CMD = 'opencode';
const DEFAULT_API_URL = 'https://api.agentteams.run';

const parseBoolean = (rawValue: string | undefined, fallback: boolean): boolean => {
  if (rawValue === undefined) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  return fallback;
};

export const getDaemonConfigPath = (): string => {
  return join(homedir(), '.agentteams', 'daemon.json');
};

const parsePositiveIntegerValue = (rawValue: string | undefined): number | undefined => {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
};

const parsePositiveInteger = (rawValue: string | undefined, fallback: number): number =>
  parsePositiveIntegerValue(rawValue) ?? fallback;

export const readDaemonConfigFile = async (): Promise<DaemonConfigFile | null> => {
  const path = getDaemonConfigPath();

  try {
    const content = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(content) as Partial<DaemonConfigFile>;

    if (!parsed.daemonToken || !parsed.apiUrl) {
      return null;
    }

    return {
      daemonToken: parsed.daemonToken,
      apiUrl: parsed.apiUrl,
    };
  } catch {
    return null;
  }
};

export const writeDaemonConfigFile = async (config: DaemonConfigFile): Promise<string> => {
  const path = getDaemonConfigPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(config, null, 2), 'utf8');
  chmodSync(path, 0o600);
  return path;
};

export const resolveRuntimeConfig = async (): Promise<RuntimeConfig> => {
  const fileConfig = await readDaemonConfigFile();
  const daemonToken = process.env.AGENTTEAMS_DAEMON_TOKEN ?? fileConfig?.daemonToken;
  const apiUrl = process.env.AGENTTEAMS_API_URL ?? fileConfig?.apiUrl ?? DEFAULT_API_URL;
  const configuredIdleTimeout = process.env.IDLE_TIMEOUT_MS;
  const parsedConfiguredIdleTimeout = parsePositiveIntegerValue(configuredIdleTimeout);

  if (configuredIdleTimeout !== undefined && parsedConfiguredIdleTimeout === undefined) {
    logger.warn('Ignoring invalid IDLE_TIMEOUT_MS; using runner or global default');
  }

  if (!daemonToken || daemonToken.trim().length === 0) {
    throw new Error("Daemon token is missing. Run 'agentrunner init --token <token>' first.");
  }

  const pollingIntervalMs = parsePositiveInteger(process.env.POLLING_INTERVAL_MS, DEFAULT_POLLING_INTERVAL_MS);

  return {
    daemonToken,
    apiUrl,
    pollingIntervalMs,
    // idle 백오프 상한. base보다 작게 설정되면 base로 올려 clamp한다(백오프가 base보다 짧아지는 무의미 상태 방지).
    maxPollingIntervalMs: Math.max(
      parsePositiveInteger(process.env.MAX_POLLING_INTERVAL_MS, DEFAULT_MAX_POLLING_INTERVAL_MS),
      pollingIntervalMs,
    ),
    timeoutMs: parsePositiveInteger(process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    idleTimeoutMs: parsedConfiguredIdleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
    isConfiguredIdleTimeoutExplicit: parsedConfiguredIdleTimeout !== undefined,
    runnerCmd: process.env.RUNNER_CMD?.trim() || DEFAULT_RUNNER_CMD,
    // macOS에서는 기본 활성. 비 macOS는 유틸 레벨에서 no-op으로 처리된다.
    preventSleepWhileBusy: parseBoolean(process.env.DAEMON_PREVENT_SLEEP, true),
  };
};

export const resolveApiUrlForInit = async (apiUrlArg?: string): Promise<string> => {
  if (apiUrlArg && apiUrlArg.trim().length > 0) {
    return apiUrlArg.trim();
  }

  const fileConfig = await readDaemonConfigFile();
  return process.env.AGENTTEAMS_API_URL ?? fileConfig?.apiUrl ?? DEFAULT_API_URL;
};
