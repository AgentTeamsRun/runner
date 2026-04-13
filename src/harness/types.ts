/**
 * Harness configuration types.
 *
 * These types define the declarative harness system that replaces
 * hard-coded proto-harness elements in the trigger handler.
 */

// ---------------------------------------------------------------------------
// Hook definitions
// ---------------------------------------------------------------------------

/** Action to take when a hook fails */
export type HookFailureAction = "fail" | "needs_review" | "warn";

/** Single hook (pre or post) definition */
export type HookDefinition = {
  name: string;
  command: string;
  onFailure: HookFailureAction;
  conventionTrigger?: string;
  conventionId?: string;
};

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/** Post-hook quality gate configuration */
export type QualityGateConfig = {
  minScore: number;
  onBelowThreshold: HookFailureAction;
};

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

/** Full harness configuration (merged result of local + server) */
export type HarnessConfig = {
  preHooks: HookDefinition[];
  postHooks: HookDefinition[];
  qualityGate: QualityGateConfig | null;
};

/** Result of parsing the local harness.yml file */
export type HarnessYml = {
  preHooks?: HookDefinition[];
  postHooks?: HookDefinition[];
  qualityGate?: QualityGateConfig | null;
};

// ---------------------------------------------------------------------------
// Server response shape
// ---------------------------------------------------------------------------

/** Shape returned by GET /api/harness-configs/:projectId */
export type ServerHarnessConfig = {
  config: HarnessYml;
};
