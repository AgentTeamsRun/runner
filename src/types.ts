export type OsType = "MACOS" | "LINUX" | "WINDOWS";

export type RuntimeConfig = {
  daemonToken: string;
  apiUrl: string;
  pollingIntervalMs: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  runnerCmd: string;
};

export type DaemonConfigFile = {
  daemonToken: string;
  apiUrl: string;
};

export type DaemonInfo = {
  id: string;
  memberId: string;
  label: string | null;
  osType: OsType | null;
  runnerVersion: string | null;
  supportedEngines: string[];
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DaemonTrigger = {
  id: string;
  prompt: string | Record<string, unknown>;
  runnerType: string;
  model: string | null;
  status: string;
  agentConfigId: string;
  startedAt: string | null;
  errorMessage: string | null;
  worktreeError: string | null;
  lastHeartbeatAt: string | null;
  conversationId: string | null;
  parentTriggerId: string | null;
  createdByMemberId: string;
  targetDaemonId: string | null;
  planMode: boolean;
  claimedByDaemonId: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  worktreeId: string | null;
  worktreeStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PendingMeta = {
  cliLatestVersion: string | null;
  runnerLatestVersion: string | null;
  restartRequested?: boolean;
};

export type PendingResponse = {
  data: DaemonTrigger | null;
  meta?: PendingMeta;
};

export type TriggerFinalStatus = "DONE" | "CANCELLED" | "FAILED" | "REJECTED";

export type ClaimResult = {
  ok: boolean;
  conflict: boolean;
};

export type TriggerRuntime = {
  triggerId: string;
  agentConfigId: string;
  authPath: string | null;
  apiKey: string;
  teamId: string;
  projectId: string;
  parentHistoryMarkdown: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  worktreeId: string | null;
};

export type TriggerLogLevel = "INFO" | "WARN" | "ERROR";

export type TriggerLogInput = {
  level: TriggerLogLevel;
  message: string;
};
