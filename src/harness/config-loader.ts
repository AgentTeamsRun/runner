import { logger } from "../logger.js";
import type { DaemonApiClient } from "../api-client.js";
import type { HarnessConfig, HarnessYml } from "./types.js";

const EMPTY_CONFIG: HarnessConfig = {
  preHooks: [],
  postHooks: [],
  qualityGate: null,
  conventionIds: []
};

export const createEmptyHarnessConfig = (): HarnessConfig => ({ ...EMPTY_CONFIG });

/**
 * Load harness config by specific harnessConfigId.
 */
export const loadHarnessConfigById = async (
  client: DaemonApiClient,
  harnessConfigId: string
): Promise<HarnessConfig> => {
  const server = await fetchServerHarnessConfigById(client, harnessConfigId);
  return server ? toHarnessConfig(server) : createEmptyHarnessConfig();
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
  qualityGate: yml.qualityGate ?? null,
  conventionIds: yml.conventionIds ?? []
});
