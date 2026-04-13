import { promises as fs } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import type { DaemonApiClient } from "../api-client.js";
import type { HarnessConfig, HarnessYml } from "./types.js";
import { parseYaml } from "./yaml-parser.js";

const HARNESS_YML_PATH = ".agentteams/harness.yml";

const EMPTY_CONFIG: HarnessConfig = {
  preHooks: [],
  postHooks: [],
  qualityGate: null
};

/**
 * Load local harness.yml from the project's authPath.
 */
export const loadLocalHarnessConfig = async (
  authPath: string
): Promise<HarnessYml | null> => {
  const filePath = join(authPath, HARNESS_YML_PATH);

  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    return parsed as unknown as HarnessYml;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }

    logger.warn("Failed to parse harness.yml, falling back to server config", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

/**
 * Fetch server-side harness config for a project.
 */
export const fetchServerHarnessConfig = async (
  client: DaemonApiClient,
  projectId: string
): Promise<HarnessYml | null> => {
  try {
    const response = await client.fetchHarnessConfig(projectId);
    if (!response) {
      return null;
    }
    return response.config;
  } catch (error) {
    logger.warn("Failed to fetch server harness config, continuing without it", {
      projectId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

/**
 * Deep merge two harness configs. Local overrides server.
 */
export const mergeHarnessConfig = (
  local: HarnessYml | null,
  server: HarnessYml | null
): HarnessConfig => {
  if (!local && !server) {
    return { ...EMPTY_CONFIG };
  }

  if (!server) {
    return toHarnessConfig(local!);
  }

  if (!local) {
    return toHarnessConfig(server);
  }

  // Local overrides server (field-level merge)
  return {
    preHooks: local.preHooks ?? server.preHooks ?? [],
    postHooks: local.postHooks ?? server.postHooks ?? [],
    qualityGate: local.qualityGate !== undefined
      ? local.qualityGate
      : server.qualityGate ?? null
  };
};

/**
 * Unified loader: load local file → fetch server → merge.
 */
export const loadHarnessConfig = async (
  authPath: string,
  client: DaemonApiClient,
  projectId: string
): Promise<HarnessConfig> => {
  const [local, server] = await Promise.all([
    loadLocalHarnessConfig(authPath),
    fetchServerHarnessConfig(client, projectId)
  ]);

  return mergeHarnessConfig(local, server);
};

/**
 * Load harness config by specific harnessConfigId.
 * Falls back to local harness.yml merge with server config.
 */
export const loadHarnessConfigById = async (
  authPath: string,
  client: DaemonApiClient,
  harnessConfigId: string
): Promise<HarnessConfig> => {
  const [local, server] = await Promise.all([
    loadLocalHarnessConfig(authPath),
    fetchServerHarnessConfigById(client, harnessConfigId)
  ]);

  return mergeHarnessConfig(local, server);
};

/**
 * Fetch server-side harness config by its id.
 */
const fetchServerHarnessConfigById = async (
  client: DaemonApiClient,
  harnessConfigId: string
): Promise<HarnessYml | null> => {
  try {
    const response = await client.fetchHarnessConfigById(harnessConfigId);
    if (!response) return null;
    return response.config;
  } catch (error) {
    logger.warn("Failed to fetch server harness config by id, continuing without it", {
      harnessConfigId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toHarnessConfig = (yml: HarnessYml): HarnessConfig => ({
  preHooks: yml.preHooks ?? [],
  postHooks: yml.postHooks ?? [],
  qualityGate: yml.qualityGate ?? null
});

const isFileNotFoundError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
};
