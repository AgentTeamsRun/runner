export type OsType = 'MACOS' | 'LINUX' | 'WINDOWS';

export type RuntimeConfig = {
  daemonToken: string;
  apiUrl: string;
  pollingIntervalMs: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  runnerCmd: string;
  preventSleepWhileBusy: boolean;
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
  fastMode: boolean;
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

// 한 polling cycle에 필요한 세 read 결과(고아 취소 대상 / 워크트리 제거 대상 / pending)를
// 한 번에 담는 통합 snapshot. meta는 기존 /pending 응답과 동일하다.
export type PollState = {
  orphanedCancelRequestedTriggerIds: string[];
  pendingWorktreeRemovals: DaemonTrigger[];
  pendingTrigger: DaemonTrigger | null;
};

export type PollStateResponse = {
  data: PollState;
  meta?: PendingMeta;
};

export type TriggerFinalStatus = 'DONE' | 'CANCELLED' | 'FAILED' | 'REJECTED' | 'NEEDS_REVIEW';

export type ClaimResult = {
  ok: boolean;
  conflict: boolean;
};

export type ConventionMeta = {
  id: string;
  filePath: string;
  trigger: string | null;
  title: string;
  description: string | null;
};

export type DaemonTriggerConventionSource = 'AUTO_MATCH' | 'PROMPT_REFERENCE' | 'USER_CUSTOM';

export type InjectedConventionRecord = {
  conventionId: string;
  source: DaemonTriggerConventionSource;
};

export type TriggerRuntime = {
  triggerId: string;
  agentConfigId: string;
  authPath: string | null;
  apiKey: string;
  teamId: string;
  projectId: string;
  runnerPrompt: string;
  attachments?: TriggerRuntimeAttachment[];
  parentHistoryMarkdown: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  worktreeId: string | null;
  conventions?: ConventionMeta[];
  planType?: string | null;
  userConventionIds?: string[];
};

export type TriggerRuntimeAttachment = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
  expiresInSeconds: number;
};

export type TriggerLogLevel = 'INFO' | 'WARN' | 'ERROR';

export type TriggerLogInput = {
  level: TriggerLogLevel;
  message: string;
};
