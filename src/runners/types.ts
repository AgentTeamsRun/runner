export interface Runner {
  run(opts: RunnerOptions): Promise<RunResult>;
}

export interface RunnerOptions {
  triggerId: string;
  prompt: string;
  authPath: string | null;
  apiKey: string;
  apiUrl: string;
  teamId: string;
  projectId: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  agentConfigId: string;
  model?: string | null;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export type RunResult = {
  exitCode: number;
  cancelled?: boolean;
  lastOutput?: string;
  outputText?: string;
  errorMessage?: string;
};
