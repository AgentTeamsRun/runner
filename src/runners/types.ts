import type { TriggerLogCategory } from '../types.js';
// 러너 타입 집합의 단일 진실 소스(SSOT). `import type`이므로 컴파일 시 완전히 제거되어
// daemon 런타임/배포 산출물(dist)에는 이 패키지 의존이 남지 않는다(zero-dependency 유지).
import type { RunnerType } from '@agentteams/core-constants';

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
  /// 이 실행을 수행하는 러너 엔진. 자식 프로세스의 실행 스냅샷 환경변수로 전달되어
  /// CLI의 `--runner-type` 폴백 값이 된다. 러너가 자기 타입 문자열을 파일마다 하드코딩하지
  /// 않도록, 값은 호출자(트리거 핸들러)가 SSOT에서 받은 것을 그대로 실어 보낸다.
  runnerType: RunnerType;
  model?: string | null;
  fastMode?: boolean;
  /// 서버가 확정한 추론 강도(Effort) 레벨. null/미지정이면 모델/클라이언트 기본값을 사용한다.
  /// CODEX/CLAUDE_CODE에서만 러너별 CLI 인자로 전달되며, 그 외 엔진에서는 무시(WARN)된다.
  effort?: string | null;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string, category: TriggerLogCategory, toolName?: string) => void;
  onStderrChunk?: (chunk: string, category: 'STDERR') => void;
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
