// 러너별 실행 옵션 지원 매트릭스의 단일 진실 소스(SSOT).
//
// 서버(설정/요청 화면)가 확정한 실행 옵션(model/fastMode)을 대상 러너가 실제로 소비하지
// 못할 때, trigger handler가 이를 무음으로 폐기하는 대신 사용자 가시 경고로 승격하기 위한
// 근거로 사용한다. 러너별로 흩어져 있던 "이 옵션을 지원하는가" 판정을 여기 한 곳에 모은다.
//
// 러너 타입 값 자체의 SSOT는 `@agentteams/core-constants`의 `RUNNER_TYPES`이지만, daemon은
// zero-dependency 원칙상 런타임에 그 패키지를 참조하지 않는다. 여기서는 팩토리
// (`runners/index.ts`)와 마찬가지로 타입만 가져와 런타임 의존성 없이 완전성을 검증한다.

import type { RunnerType as KnownRunnerType } from '@agentteams/core-constants';

export interface RunnerCapabilities {
  /** 요청된 model 식별자를 하위 CLI에 전달/적용하는가. */
  model: boolean;
  /** fast-inference 모드(fastMode)를 실제로 반영하는가. */
  fastMode: boolean;
  /**
   * 서브 에이전트 위임을 비동기(백그라운드)로 수행해, 위임 호출 계층의 별도 응답 제한
   * (러너 idle/fail-safe timeout과 무관한 per-call 제한)을 회피할 수 있는 검증된
   * 메커니즘이 있는가. 러너 요청 프롬프트의 위임 정책 분기(전용 문구 vs 러너-무관 안전
   * 문구)가 이 판정을 따른다.
   *
   * [Intentional mirror] 프롬프트는 API가 조립하지만 daemon은 zero-dependency 원칙상
   * API가 런타임에 이 파일을 참조할 수 없으므로, 판정 결과를
   * `api/src/services/runnerCapabilities.ts`에 미러링한다. 이 값을 바꾸면 그쪽도 함께
   * 갱신한다.
   */
  subAgentDelegation: boolean;
}

export const RUNNER_CAPABILITIES: Record<KnownRunnerType, RunnerCapabilities> = {
  // claude-code(-p --model / --settings fastMode)와 codex(--model / -c features.fast_mode)만
  // 두 옵션을 실제로 소비한다.
  // claude-code는 서브 에이전트(Task 도구)의 `run_in_background` 파라미터로 비동기 위임과
  // 결과 별도 회수를 지원하는 유일한 러너다(Claude Code 2.x 런타임 계약으로 확인).
  CLAUDE_CODE: { model: true, fastMode: true, subAgentDelegation: true },
  CODEX: { model: true, fastMode: true, subAgentDelegation: false },
  // opencode는 --model만 전달하며 fastMode는 반영하지 않는다.
  OPENCODE: { model: true, fastMode: false, subAgentDelegation: false },
  // antigravity(agy --print)는 --model을 지원하지만 fastMode는 반영하지 않는다.
  ANTIGRAVITY: { model: true, fastMode: false, subAgentDelegation: false },
  // AMP는 `--model`이 아니라 `--mode`로 실행 프로필을 선택하므로 model:true로 둔다.
  // 실제 인자 조립은 runners/amp.ts에서 AmpCode 전용 계약으로 문서화한다.
  AMP: { model: true, fastMode: false, subAgentDelegation: false },
  COPILOT_CLI: { model: true, fastMode: false, subAgentDelegation: false },
};

const DEFAULT_CAPABILITIES: RunnerCapabilities = { model: false, fastMode: false, subAgentDelegation: false };

export const getRunnerCapabilities = (runnerType: string): RunnerCapabilities =>
  RUNNER_CAPABILITIES[runnerType as KnownRunnerType] ?? DEFAULT_CAPABILITIES;

export const runnerSupportsFastMode = (runnerType: string): boolean => getRunnerCapabilities(runnerType).fastMode;

export const runnerSupportsSubAgentDelegation = (runnerType: string): boolean =>
  getRunnerCapabilities(runnerType).subAgentDelegation;

export type UnsupportedRunnerOption = {
  option: 'model' | 'fastMode';
  message: string;
};

// 요청됐지만 대상 러너가 지원하지 않는 실행 옵션과 그 사용자 노출 경고 문구를 만든다.
// trigger handler가 반환된 각 항목을 로그 리포터(WARN)로 흘려 사용자 가시 신호로 남긴다.
export const describeUnsupportedRunnerOptions = (
  runnerType: string,
  options: { model?: string | null; fastMode?: boolean | null },
): UnsupportedRunnerOption[] => {
  const capabilities = getRunnerCapabilities(runnerType);
  const warnings: UnsupportedRunnerOption[] = [];

  if (typeof options.model === 'string' && options.model.trim().length > 0 && !capabilities.model) {
    warnings.push({
      option: 'model',
      message: `Model selection is not supported by runner ${runnerType}; the requested model "${options.model}" was ignored.`,
    });
  }

  if (options.fastMode && !capabilities.fastMode) {
    warnings.push({
      option: 'fastMode',
      message: `Fast mode is not supported by runner ${runnerType}; the requested fast mode was ignored.`,
    });
  }

  return warnings;
};
