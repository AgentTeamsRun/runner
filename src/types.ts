export type RuntimeConfig = {
  daemonToken: string;
  apiUrl: string;
  pollingIntervalMs: number;
  timeoutMs: number;
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
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DaemonTrigger = {
  id: string;
  prompt: string;
  runnerType: string;
  status: string;
  agentConfigId: string;
  startedAt: string | null;
  createdByMemberId: string;
  claimedByDaemonId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TriggerFinalStatus = "DONE" | "FAILED" | "REJECTED";

export type ClaimResult = {
  ok: boolean;
  conflict: boolean;
};

export type TriggerRuntime = {
  triggerId: string;
  agentConfigId: string;
  authPath: string | null;
  apiKey: string;
};
