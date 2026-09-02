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
   * 서버가 확정한 추론 강도(Effort) 레벨을 하위 CLI 인자로 전달/적용하는가.
   * CODEX(`-c model_reasoning_effort`)와 CLAUDE_CODE(`--effort`)만 지원한다.
   * 실제 허용 레벨은 API가 모델 메타데이터로 검증하므로 daemon은 값 검증을 중복하지 않는다.
   */
  effort: boolean;
  /**
   * 설치된 하위 CLI가 현재 계정/머신에서 선택 가능한 모델 목록을 비대화형으로 열거하는가.
   * 실제 열거 명령과 파서는 `utils/model-enumerator.ts`가 이 축을 기준으로 선택한다.
   * 열거 서브커맨드가 없는 러너는 false다. AMP는 모델이 아니라 고정 `--mode` 축이다.
   */
  modelEnumeration: boolean;
  /**
   * 서브 에이전트 위임을 비동기(백그라운드)로 수행해, 위임 호출 계층의 별도 응답 제한
   * (러너 idle/fail-safe timeout과 무관한 per-call 제한)을 회피할 수 있는 검증된
   * 메커니즘이 있는가. 러너 요청 프롬프트의 위임 정책 분기(전용 문구 vs 러너-무관 안전
   * 문구)가 이 판정을 따른다.
   *
   * [Intentional mirror] 프롬프트는 API가 조립하지만 daemon은 zero-dependency 원칙상
   * API가 런타임에 이 파일을 참조할 수 없으므로, 판정 결과를
   * `api/src/services/runnerCapabilities.ts`에 미러링한다. 이 값을 바꾸면 그쪽도 함께
   * 갱신한다. 어긋나면 `scripts/runner-capability-contract.test.mjs`가 잡는다.
   */
  subAgentDelegation: boolean;
}

export const RUNNER_CAPABILITIES: Record<KnownRunnerType, RunnerCapabilities> = {
  // claude-code(-p --model / --settings fastMode)와 codex(--model / -c features.fast_mode)만
  // 두 옵션을 실제로 소비한다.
  // claude-code는 서브 에이전트(Task 도구)의 `run_in_background` 파라미터로 비동기 위임과
  // 결과 별도 회수를 지원하는 유일한 러너다(Claude Code 2.x 런타임 계약으로 확인).
  CLAUDE_CODE: { model: true, fastMode: true, effort: true, modelEnumeration: false, subAgentDelegation: true },
  // codex-cli 0.152.0의 `codex debug models`가 현재 설치·인증 환경의 JSON 카탈로그를
  // 비대화형으로 제공함을 확인했다(2026-09-03). 숨김/API 미지원 항목은 파서에서 제외한다.
  CODEX: { model: true, fastMode: true, effort: true, modelEnumeration: true, subAgentDelegation: false },
  // opencode는 --model만 전달하며 fastMode/effort는 반영하지 않는다.
  OPENCODE: { model: true, fastMode: false, effort: false, modelEnumeration: true, subAgentDelegation: false },
  // antigravity(agy --print)는 --model을 지원하지만 fastMode/effort는 반영하지 않는다.
  ANTIGRAVITY: { model: true, fastMode: false, effort: false, modelEnumeration: true, subAgentDelegation: false },
  // AMP는 `--model`이 아니라 `--mode`로 실행 프로필을 선택하므로 model:true로 둔다.
  // 실제 인자 조립은 runners/amp.ts에서 AmpCode 전용 계약으로 문서화한다.
  AMP: { model: true, fastMode: false, effort: false, modelEnumeration: false, subAgentDelegation: false },
  COPILOT_CLI: { model: true, fastMode: false, effort: false, modelEnumeration: false, subAgentDelegation: false },
  CURSOR_CLI: { model: true, fastMode: false, effort: false, modelEnumeration: true, subAgentDelegation: false },
  KIMI_CLI: { model: true, fastMode: false, effort: false, modelEnumeration: false, subAgentDelegation: false },
  // kiro-cli는 `chat --model <MODEL>`을 실제로 소비한다(2026-08-08 실측).
  // effort는 `--effort` 플래그가 존재하지만 잘못된 레벨도 조용히 수용되고 low/max가 동일
  // 크레딧을 소모해 효과를 실증하지 못했으므로 false로 둔다.
  // subAgentDelegation은 Kiro 서브에이전트가 메인 에이전트의 완료 대기(blocking) 모델이라 false.
  KIRO_CLI: { model: true, fastMode: false, effort: false, modelEnumeration: true, subAgentDelegation: false },
  // grok(Grok Build)은 `-m <MODEL>`을 실제로 소비한다(2026-08-14 실측, grok 1.0.3).
  // `grok models`가 노출하는 유일한 값 `grok-4.6`은 exit 0으로 실행되고 result.modelUsage에
  // 그대로 보고된다. 알 수 없는 값은 exit 1 + `unknown model id`라 조용한 폴백이 없다.
  // modelEnumeration은 `grok models`가 `Available models:` 아래 `  * <id> (default)` 형태의
  // 기계 파싱 가능한 목록을 내보내 true다(JSON 출력 플래그는 없다).
  // effort는 `--reasoning-effort`(alias `--effort`)가 존재하고 무효 레벨을 거부하지만
  // (`use one of: xhigh, high, medium, low`), 동일 프롬프트에서 low↔xhigh의 reasoning
  // 토큰 차이가 935↔996으로 노이즈 수준이라 효과를 실증하지 못해 false로 둔다(Kiro와 같은 기준).
  // subAgentDelegation은 `spawn_subagent`로 위임하고 `get_command_or_subagent_output`
  // (task_ids + timeout_ms)으로 결과를 별도 회수하는 흐름이 헤드리스 실행에서 동작함을 실측했다.
  GROK_BUILD: { model: true, fastMode: false, effort: false, modelEnumeration: true, subAgentDelegation: true },
  // omp/18.0.4 (2026-08-25 실측). `--model`은 무효 값도 exit 1로 거부한다.
  // modelEnumeration은 `omp models --json`이 기계 파싱 가능한 카탈로그를 내보내 true다.
  // 단 카탈로그는 **공급자 자격 증명이 하나라도 있을 때만** 나온다. 키가 전혀 없으면
  // `{ "models": [] }`이고, `OPENROUTER_API_KEY`에 임의 문자열만 넣어도 openrouter
  // 공개 카탈로그 470건이 나온다(키 유효성은 검증하지 않는다). 즉 목록에 있다고 실제
  // 호출이 되는 것은 아니고, 실행 가능 여부는 트리거가 실패해야 드러난다.
  // AgentTeams fastMode/Effort에 대응하는 플래그는 없다(`--effort`는 unknown flag).
  // `task` 위임은 헤드리스에서 호출/회수 분리를 실증하지 못해 false.
  OMP: { model: true, fastMode: false, effort: false, modelEnumeration: true, subAgentDelegation: false },
};

const DEFAULT_CAPABILITIES: RunnerCapabilities = {
  model: false,
  fastMode: false,
  effort: false,
  modelEnumeration: false,
  subAgentDelegation: false,
};

export const getRunnerCapabilities = (runnerType: string): RunnerCapabilities =>
  RUNNER_CAPABILITIES[runnerType as KnownRunnerType] ?? DEFAULT_CAPABILITIES;

export const runnerSupportsFastMode = (runnerType: string): boolean => getRunnerCapabilities(runnerType).fastMode;

export const runnerSupportsEffort = (runnerType: string): boolean => getRunnerCapabilities(runnerType).effort;

export const runnerSupportsSubAgentDelegation = (runnerType: string): boolean =>
  getRunnerCapabilities(runnerType).subAgentDelegation;

export type UnsupportedRunnerOption = {
  option: 'model' | 'fastMode' | 'effort';
  message: string;
};

// 요청됐지만 대상 러너가 지원하지 않는 실행 옵션과 그 사용자 노출 경고 문구를 만든다.
// trigger handler가 반환된 각 항목을 로그 리포터(WARN)로 흘려 사용자 가시 신호로 남긴다.
export const describeUnsupportedRunnerOptions = (
  runnerType: string,
  options: { model?: string | null; fastMode?: boolean | null; effort?: string | null },
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

  if (typeof options.effort === 'string' && options.effort.trim().length > 0 && !capabilities.effort) {
    warnings.push({
      option: 'effort',
      message: `Effort level is not supported by runner ${runnerType}; the requested effort "${options.effort}" was ignored.`,
    });
  }

  return warnings;
};
