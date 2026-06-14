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
  fastMode?: boolean;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export type RunResult = {
  exitCode: number;
  cancelled?: boolean;
  /// 무출력 idle 워치독에 의해 종료된 경우 true. 일부 러너(예: Antigravity)는 답변 생성을
  /// 끝낸 뒤 종료 시퀀스에서 행이 걸려 무출력으로 kill되는데, 이때 산출물(히스토리 파일)은
  /// 이미 온전하다. 핸들러가 이 신호로 hard-FAIL 대신 NEEDS_REVIEW 강등을 판단한다.
  idleTimedOut?: boolean;
  lastOutput?: string;
  outputText?: string;
  errorMessage?: string;
};
