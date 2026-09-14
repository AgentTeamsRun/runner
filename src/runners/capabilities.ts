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
  /** 환경변수나 태스크가 지정하지 않았을 때 적용할 러너별 idle timeout. */
  defaultIdleTimeoutMs?: number;
  /** 요청된 model 식별자를 하위 CLI에 전달/적용하는가. */
  model: boolean;
  /** fast-inference 모드(fastMode)를 실제로 반영하는가. */
  fastMode: boolean;
  /**
   * 서버가 확정한 추론 강도(Effort) 레벨을 하위 CLI 인자로 전달/적용하는가.
   * 엔진별 플래그는 각 어댑터가 소유하며 공통 허용 집합과 계약 테스트로 대조한다.
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
  /**
   * 실행 결과에서 주 실행 루프의 토큰 사용량을 구조화된 이벤트로 수집할 수 있는가.
   * 값 매핑 계약은 `runners/fixtures/token-usage.md`가 소유한다.
   */
  tokenUsage: boolean;
}

export const RUNNER_CAPABILITIES: Record<KnownRunnerType, RunnerCapabilities> = {
  // claude-code(-p --model / --settings fastMode)와 codex(--model / -c features.fast_mode)만
  // 두 옵션을 실제로 소비한다.
  // claude-code는 서브 에이전트(Task 도구)의 `run_in_background` 파라미터로 비동기 위임과
  // 결과 별도 회수를 지원하는 유일한 러너다(Claude Code 2.x 런타임 계약으로 확인).
  // 최근 30일 체인 노드 표본 23건(최대 27.1분)으로 유일하게 상대적으로 표본이 충분하다.
  // 30분은 관측 최대를 수용하며, 표본이 10건 이하인 다른 러너는 전역 기본값에 맡긴다.
  CLAUDE_CODE: {
    defaultIdleTimeoutMs: 1_800_000,
    model: true,
    fastMode: true,
    effort: true,
    modelEnumeration: false,
    subAgentDelegation: true,
    tokenUsage: true,
  },
  // codex-cli 0.152.0의 `codex debug models`가 현재 설치·인증 환경의 JSON 카탈로그를
  // 비대화형으로 제공함을 확인했다(2026-09-03). 숨김/API 미지원 항목은 파서에서 제외한다.
  // 토큰 사용량은 `turn.completed.usage`로 보고됨을 확인했다(2026-09-07,
  // fixtures/codex-events.jsonl). 세션 키는 `thread.started.thread_id`다.
  CODEX: {
    model: true,
    fastMode: true,
    effort: true,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: true,
  },
  // OpenCode 1.18.18: 모델 카탈로그의 variant를 `run --variant`로 전달한다.
  OPENCODE: {
    model: true,
    fastMode: false,
    effort: true,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: true,
  },
  // agy 1.1.27: 세션 --effort. 모델 접미사와 충돌하면 CLI가 명시적으로 거부한다.
  // 평문 출력이라 구조화 사용량 이벤트가 없다.
  ANTIGRAVITY: {
    model: true,
    fastMode: false,
    effort: true,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: false,
  },
  // AMP는 `--model`이 아니라 `--mode`로 실행 프로필을 선택하므로 model:true로 둔다.
  // 실제 인자 조립은 runners/amp.ts에서 AmpCode 전용 계약으로 문서화한다.
  // 2026-09-12 실측: assistant message.usage에 네 토큰 필드, 모든 이벤트에 session_id.
  // result.usage와 message.id는 없다. 메시지별 합산과 end_turn 판정을 사용하며
  // 합성 순번으로 중복 제거는 불가능하다(fixtures/amp-usage.jsonl).
  AMP: {
    model: true,
    fastMode: false,
    effort: false,
    modelEnumeration: false,
    subAgentDelegation: false,
    tokenUsage: true,
  },
  // Copilot CLI는 assistant.message.data.outputTokens만 보고한다. 입력·캐시는
  // 엔진이 제공하지 않으므로 수집 상태는 PARTIAL이 상한이다(축은 boolean이므로
  // 부분 지원의 의미는 주석과 fixtures/token-usage.md가 소유한다).
  COPILOT_CLI: {
    model: true,
    fastMode: false,
    effort: true,
    modelEnumeration: false,
    subAgentDelegation: false,
    tokenUsage: true,
  },
  // Cursor는 effort 접미사가 있는 모델 id를 선택한다. 별도 축의 모델별 계약은 미확인이다.
  // 토큰 사용량: 미지원(정적 확인, 2026-09-08). 전용 파서의 라인 타입
  // `CursorStreamJsonLine`(stream-json-parser.ts) 선언에 usage 필드가 없고 파서도
  // 텍스트 로그 정제만 하므로 실행 프로브 없이 판정한다.
  CURSOR_CLI: {
    model: true,
    fastMode: false,
    effort: false,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: false,
  },
  // Kimi는 설정 파일의 thinking.effort만 확인됐고 실행 단위 전달 경로는 미확인이다.
  // `kimi provider list --json`이 `models` 맵을 낸다(2026-09-12 실측, kimi 0.42.0).
  // 키 미설정이면 빈 맵. 출력에 provider apiKey가 평문으로 포함되므로 파서는 `models`만 읽는다.
  // 토큰 사용량: 미지원(2026-09-13 실측, kimi 0.42.0). print-mode는
  // `--output-format stream-json` JSONL(role=meta/assistant/tool)이며 사용량 정수
  // 필드가 없다. 성공 스키마는 fixtures/kimi-events.jsonl. 같은 설치본의 유료
  // 프로브는 계정 잔액 부족(429)으로 assistant 행까지 도달하지 못했고 버전 meta만
  // 관측했다. 공식 문서도 Assistant/Tool만 명시한다. 세션 디렉터리 내부 로그는
  // 이 stdout 계약이 아니며 수집하지 않는다.
  KIMI_CLI: {
    model: true,
    fastMode: false,
    effort: false,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: false,
  },
  // kiro-cli는 `chat --model <MODEL>`을 실제로 소비한다(2026-08-08 실측).
  // `--effort`는 공식 지원되지만 ~/.kiro/settings/cli.json에 자동 저장된다.
  // 전역 설정을 변경하지 않는 실행 단위 경로가 확인될 때까지 미지원이다.
  // 근거: https://kiro.dev/docs/models/effort/ (2026-09-07). 토큰 차이는 판정 기준이 아니다.
  // subAgentDelegation은 Kiro 서브에이전트가 메인 에이전트의 완료 대기(blocking) 모델이라 false.
  // 평문 출력이라 구조화 사용량 이벤트가 없다.
  KIRO_CLI: {
    model: true,
    fastMode: false,
    effort: false,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: false,
  },
  // grok(Grok Build)은 `-m <MODEL>`을 실제로 소비한다(2026-08-14 실측, grok 1.0.3).
  // `grok models`가 노출하는 유일한 값 `grok-4.6`은 exit 0으로 실행되고 result.modelUsage에
  // 그대로 보고된다. 알 수 없는 값은 exit 1 + `unknown model id`라 조용한 폴백이 없다.
  // modelEnumeration은 `grok models`가 `Available models:` 아래 `  * <id> (default)` 형태의
  // 기계 파싱 가능한 목록을 내보내 true다(JSON 출력 플래그는 없다).
  // grok 1.0.13: --reasoning-effort가 ACP session/set_model의 _meta.reasoningEffort로
  // 전달되고 응답 모델 메타데이터에도 적용됨을 확인했다(2026-09-07, grok-4.6 low).
  // 공식 계약: https://x.ai/build/changelog — 토큰 차이로 지원 여부를 판정하지 않는다.
  // subAgentDelegation은 `spawn_subagent`로 위임하고 `get_command_or_subagent_output`
  // (task_ids + timeout_ms)으로 결과를 별도 회수하는 흐름이 헤드리스 실행에서 동작함을 실측했다.
  // 토큰 사용량은 `--output-format streaming-messages-json`의 `result.usage`로
  // 보고됨을 확인했다(2026-09-08, grok 1.0.13, fixtures/grok-usage.jsonl).
  // assistant `message.usage` 합이 result 누적값과 일치하고 세션 키는 모든 이벤트의
  // `session_id`다. `result.modelUsage`는 같은 수치의 모델별 분해라 매핑하지 않는다.
  GROK_BUILD: {
    model: true,
    fastMode: false,
    effort: true,
    modelEnumeration: true,
    subAgentDelegation: true,
    tokenUsage: true,
  },
  // omp/18.0.4 (2026-08-25 실측). `--model`은 무효 값도 exit 1로 거부한다.
  // modelEnumeration은 `omp models --json`이 기계 파싱 가능한 카탈로그를 내보내 true다.
  // 단 카탈로그는 **공급자 자격 증명이 하나라도 있을 때만** 나온다. 키가 전혀 없으면
  // `{ "models": [] }`이고, `OPENROUTER_API_KEY`에 임의 문자열만 넣어도 openrouter
  // 공개 카탈로그 470건이 나온다(키 유효성은 검증하지 않는다). 즉 목록에 있다고 실제
  // 호출이 되는 것은 아니고, 실행 가능 여부는 트리거가 실패해야 드러난다.
  // omp 18.1.2: 카탈로그 thinking 레벨을 --thinking으로 전달한다. fastMode는 미지원.
  // `task` 위임은 헤드리스에서 호출/회수 분리를 실증하지 못해 false.
  // 토큰 사용량은 assistant `message_end.message.usage`로 보고됨을 확인했다(2026-09-07,
  // fixtures/omp-events.jsonl). 세션 키는 `session` 이벤트의 최상위 `id`다.
  OMP: {
    model: true,
    fastMode: false,
    effort: true,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: true,
  },
  // muse 1.0.2, 2026-09-04 실측: exec의 --model/--reasoning-effort 지원,
  // serve의 MSP model/list 지원. fast 전용 플래그와 exec 위임/회수는 없다.
  // MSP v1 봉투에 usage가 없다.
  MUSE_CODE: {
    model: true,
    fastMode: false,
    effort: true,
    modelEnumeration: true,
    subAgentDelegation: false,
    tokenUsage: false,
  },
};

const DEFAULT_CAPABILITIES: RunnerCapabilities = {
  model: false,
  fastMode: false,
  effort: false,
  modelEnumeration: false,
  subAgentDelegation: false,
  tokenUsage: false,
};

export const getRunnerCapabilities = (runnerType: string): RunnerCapabilities =>
  RUNNER_CAPABILITIES[runnerType as KnownRunnerType] ?? DEFAULT_CAPABILITIES;

export const runnerSupportsFastMode = (runnerType: string): boolean => getRunnerCapabilities(runnerType).fastMode;

export const runnerSupportsEffort = (runnerType: string): boolean => getRunnerCapabilities(runnerType).effort;

export const getRunnerDefaultIdleTimeoutMs = (runnerType: string): number | undefined =>
  getRunnerCapabilities(runnerType).defaultIdleTimeoutMs;

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
