import { getRunnerCapabilities, RUNNER_CAPABILITIES } from './capabilities.js';
import { createJsonLineBuffer } from './json-line-buffer.js';

export type TokenUsage = {
  status: 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'UNSUPPORTED';
  scope: 'MAIN_LOOP';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
};

type Counts = Omit<TokenUsage, 'status' | 'scope'>;
const keys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const;
type TokenUsageField = (typeof keys)[number];
const empty = (): Counts => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
});
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : count(a + b));

type UsageSupportedRunner = 'CLAUDE_CODE' | 'OPENCODE' | 'CODEX' | 'OMP' | 'COPILOT_CLI';

// 지원 판정의 SSOT는 `RUNNER_CAPABILITIES.tokenUsage`다. 이 목록은 거기서 파생되며,
// 러너 이름을 직접 나열하지 않는다.
export const usageSupportedRunners: readonly UsageSupportedRunner[] = (
  Object.keys(RUNNER_CAPABILITIES) as (keyof typeof RUNNER_CAPABILITIES)[]
).filter((runnerType): runnerType is UsageSupportedRunner => getRunnerCapabilities(runnerType).tokenUsage);

export const emptyTokenUsage = (runnerType: string): TokenUsage => ({
  ...empty(),
  scope: 'MAIN_LOOP',
  status: getRunnerCapabilities(runnerType).tokenUsage ? 'MISSING' : 'UNSUPPORTED',
});

type EngineParseResult =
  | { kind: 'ignore' }
  | { kind: 'session'; sessionId: unknown }
  | {
      kind: 'usage';
      sessionId?: unknown;
      extraSessionId?: unknown;
      counts: Counts;
      id?: unknown;
      terminal: boolean;
      final?: boolean;
    };

// 엔진별 수집 서술. 세션 키 출처·단계 식별·완결성 판정을 한 곳에 묶어
// `acceptEvent`의 엔진 분기를 테이블로 정리한다. 새 엔진은 항목만 추가한다.
export type TokenUsageEngineDescriptor = {
  // COMPLETE 판정에 필요한 필드 집합. 엔진에 없는 필드는 여기서 제외한다.
  // 저장 스키마는 바꾸지 않으며 이 집합은 daemon 내부 판정용이다.
  reportableKeys: readonly TokenUsageField[];
  // 사용량 이벤트가 세션 id 없이 와도 받아들이는가.
  // 하위 프로세스 1개 = 세션 1개를 전제로, 세션 불일치가 실제로 관측될 때만 수치를 비운다.
  allowUsageWithoutSession: boolean;
  // id가 없는 엔진은 순번 합성 키를 쓴다. 이때 중복 제거가 불가능하다는 사실을
  // 호출자와 계약 문서에 명시한다.
  useSyntheticId: boolean;
  parse: (event: Record<string, unknown>) => EngineParseResult;
};

const parseClaudeCode = (event: Record<string, unknown>): EngineParseResult => {
  if (event.type !== 'assistant' && event.type !== 'result') return { kind: 'ignore' };
  if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return { kind: 'ignore' };
  if (event.type === 'result') {
    const usage = record(event.usage);
    return {
      kind: 'usage',
      sessionId: event.session_id,
      counts: {
        inputTokens: count(usage.input_tokens),
        outputTokens: count(usage.output_tokens),
        cacheReadInputTokens: count(usage.cache_read_input_tokens),
        cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
      },
      terminal: true,
      final: true,
    };
  }
  const message = record(event.message);
  const usage = record(message.usage);
  return {
    kind: 'usage',
    sessionId: event.session_id,
    counts: {
      inputTokens: count(usage.input_tokens),
      // assistant 출력 값은 placeholder이므로 최종 result 전에는 출력 토큰을 null로 둔다.
      outputTokens: null,
      cacheReadInputTokens: count(usage.cache_read_input_tokens),
      cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
    },
    id: message.id,
    terminal: false,
  };
};

const parseOpencode = (event: Record<string, unknown>): EngineParseResult => {
  const part = record(event.part);
  if (event.type === 'error') return { kind: 'ignore' };
  if (part.type !== 'step-finish') return { kind: 'ignore' };
  const tokens = record(part.tokens);
  const cache = record(tokens.cache);
  return {
    kind: 'usage',
    sessionId: event.sessionID,
    extraSessionId: part.sessionID,
    counts: {
      inputTokens: count(tokens.input),
      outputTokens: add(count(tokens.output), count(tokens.reasoning)),
      cacheReadInputTokens: count(cache.read),
      cacheCreationInputTokens: count(cache.write),
    },
    id: part.id,
    terminal: part.reason === 'stop',
  };
};

const parseCodex = (event: Record<string, unknown>): EngineParseResult => {
  if (event.type === 'thread.started') return { kind: 'session', sessionId: event.thread_id };
  if (event.type !== 'turn.completed') return { kind: 'ignore' };
  const usage = record(event.usage);
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens);
  // codex의 input_tokens는 캐시 읽기분을 포함한다. 계약(입력에 캐시 중복 포함 금지)에
  // 맞추려면 빼야 한다. 근거: TokenUsage::non_cached_input() = input - cached
  // (codex-rs/protocol/src/protocol.rs), Usage 구조체 주석
  // (codex-rs/exec/src/exec_events.rs, 2026-09-07 확인).
  const inputTokens = input === null ? null : cached === null ? input : count(input - cached);
  return {
    kind: 'usage',
    counts: {
      inputTokens,
      // output_tokens는 추론 토큰을 이미 포함한다. 더하면 이중 계산이 된다.
      // 근거: blended_total() = non_cached_input + output_tokens (reasoning 별도 가산 없음),
      // "Fix Codex token usage double-counting reasoning tokens" 수정과 동일 판정.
      outputTokens: count(usage.output_tokens),
      cacheReadInputTokens: cached,
      // 구버전 fixture에는 대응 필드가 없어 null이다. 신버전은 cache_write_input_tokens을
      // 내보내므로 있으면 읽는다. 보고 가능 집합에서는 제외해 null이어도 COMPLETE다.
      cacheCreationInputTokens: count(usage.cache_write_input_tokens),
    },
    terminal: true,
  };
};

const parseOmp = (event: Record<string, unknown>): EngineParseResult => {
  if (event.type === 'session') return { kind: 'session', sessionId: event.id };
  if (event.type !== 'message_end') return { kind: 'ignore' };
  const message = record(event.message);
  if (message.role !== 'assistant') return { kind: 'ignore' };
  const usage = record(message.usage);
  return {
    kind: 'usage',
    counts: {
      inputTokens: count(usage.input),
      outputTokens: count(usage.output),
      cacheReadInputTokens: count(usage.cacheRead),
      cacheCreationInputTokens: count(usage.cacheWrite),
    },
    terminal: message.stopReason === 'stop',
  };
};

const parseCopilot = (event: Record<string, unknown>): EngineParseResult => {
  if (event.type === 'result') {
    // 세션 키는 최종 result의 최상위 sessionId에만 있다. 토큰 수치는 싣지 않으므로
    // 세션 확정으로만 쓰고 종료 근거(terminal)는 세션 확정으로 갈음한다.
    // 상태는 입력 부재 상한에 따라 PARTIAL이 상한이다.
    return { kind: 'session', sessionId: event.sessionId };
  }
  if (event.type !== 'assistant.message') return { kind: 'ignore' };
  const data = record(event.data);
  return {
    kind: 'usage',
    counts: {
      inputTokens: null,
      outputTokens: count(data.outputTokens),
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    },
    id: data.messageId,
    terminal: false,
  };
};

const ENGINE_DESCRIPTORS: Record<UsageSupportedRunner, TokenUsageEngineDescriptor> = {
  CLAUDE_CODE: {
    reportableKeys: keys,
    allowUsageWithoutSession: false,
    useSyntheticId: false,
    parse: parseClaudeCode,
  },
  OPENCODE: {
    reportableKeys: keys,
    allowUsageWithoutSession: false,
    useSyntheticId: false,
    parse: parseOpencode,
  },
  CODEX: {
    // turn.completed.usage는 턴별 값("during a turn")이므로 합성 키로 턴 합산한다.
    // id가 없어 중복 행을 제거할 수 없다.
    reportableKeys: ['inputTokens', 'outputTokens', 'cacheReadInputTokens'],
    allowUsageWithoutSession: true,
    useSyntheticId: true,
    parse: parseCodex,
  },
  OMP: {
    // assistant message_end.message.usage를 턴 합산한다. message.id가 null이므로
    // 순번 합성 키를 쓰고 중복 행을 제거할 수 없다. reasoningTokens는 total 합산에
    // 이미 포함돼 있어(input + cacheRead + output = totalTokens) 더하면 이중 계산이 된다.
    // 종료 근거는 마지막 assistant message_end.stopReason === 'stop'이다.
    // turn_end는 message_end와 동일 사용량을 중복하므로 제외하고, agent_end는
    // 사용량을 싣지 않으므로 종료 근거로 쓰지 않는다.
    reportableKeys: keys,
    allowUsageWithoutSession: true,
    useSyntheticId: true,
    parse: parseOmp,
  },
  COPILOT_CLI: {
    // assistant.message.data.outputTokens를 메시지 단위로 합산한다. fixture 3건
    // (428/253/17)이 단조 증가하지 않으므로 누적값이 아니라 메시지 단위로 판단한다.
    // Copilot CLI 문서에 누적 명세가 없어 fixture 관측에 근거하며, 불확실성은
    // fixtures/token-usage.md에 명시한다. 입력·캐시는 엔진이 제공하지 않는다.
    // totalNanoAiu·premiumRequests·totalApiDurationMs는 토큰이 아니라 매핑하지 않는다.
    // 세션 키는 최종 result.sessionId에만 있어 사용량 이벤트는 세션 없이 받는다.
    reportableKeys: ['outputTokens'],
    allowUsageWithoutSession: true,
    useSyntheticId: false,
    parse: parseCopilot,
  },
};

// 원문은 보존하지 않는다. 행 버퍼와 중복 제거 표를 제한해 잘못된 출력이 실행을 실패시키지 않게 한다.
const createCollectorWithDescriptor = (descriptor: TokenUsageEngineDescriptor) => {
  let incomplete = false;
  let invalidSession = false;
  let session: string | undefined;
  let terminal = false;
  let finalCounts: Counts | undefined;
  let syntheticSeq = 0;
  const steps = new Map<string, Counts>();
  const acceptSessionId = (value: unknown): boolean => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      invalidSession = true;
      return false;
    }
    session ??= value;
    if (session !== value) {
      invalidSession = true;
      return false;
    }
    return true;
  };
  const acceptEvent = (value: unknown): void => {
    const event = record(value);
    const parsed = descriptor.parse(event);
    if (parsed.kind === 'ignore') return;
    if (parsed.kind === 'session') {
      acceptSessionId(parsed.sessionId);
      return;
    }
    if (parsed.sessionId !== undefined) {
      if (!acceptSessionId(parsed.sessionId)) return;
      if (parsed.extraSessionId !== undefined && parsed.extraSessionId !== session) {
        invalidSession = true;
        return;
      }
    } else {
      if (parsed.extraSessionId !== undefined) {
        if (session === undefined) {
          if (!acceptSessionId(parsed.extraSessionId)) return;
        } else if (parsed.extraSessionId !== session) {
          invalidSession = true;
          return;
        }
      } else if (!descriptor.allowUsageWithoutSession) {
        invalidSession = true;
        return;
      }
    }
    if (parsed.final) {
      // 최종 누적값은 부분 합계에 더하지 않는다. 누락 필드만 기존 부분값을 보존한다.
      const previous = aggregate();
      finalCounts = Object.fromEntries(keys.map((key) => [key, parsed.counts[key] ?? previous[key]])) as Counts;
      // 종료 근거 도착. COMPLETE 여부는 get()의 보고 가능 집합이 가린다.
      terminal = true;
      return;
    }
    let key: string;
    if (descriptor.useSyntheticId) {
      key = `__seq_${syntheticSeq++}`;
    } else {
      const id = parsed.id;
      if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        incomplete = true;
        return;
      }
      key = id;
    }
    if (!steps.has(key) && steps.size >= 10000) {
      incomplete = true;
      return;
    }
    steps.set(key, parsed.counts);
    terminal = parsed.terminal;
  };
  const aggregate = (): Counts => {
    if (finalCounts) return finalCounts;
    if (steps.size === 0) return empty();
    const values = [...steps.values()];
    return Object.fromEntries(
      keys.map((key) => [key, values.reduce<number | null>((sum, value) => add(sum, value[key]), 0)]),
    ) as Counts;
  };
  const markDropped = () => {
    incomplete = true;
  };
  const lineBuffer = createJsonLineBuffer((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    acceptEvent(value);
  }, markDropped);
  return {
    ...lineBuffer,
    acceptEvent,
    markDropped,
    get(interrupted = false): TokenUsage {
      const counts = invalidSession ? empty() : aggregate();
      const hasCounts = keys.some((key) => counts[key] !== null);
      // COMPLETE의 최소 요건은 입력·출력 토큰 둘 다 수집됨이다. 보고 가능 집합만으로는
      // 출력만 보고하는 엔진이 COMPLETE가 되어 "실행 사용량 전부"로 오해된다.
      // 이 상한은 엔진 서술에서 파생되는 일반 규칙이며 특정 엔진 특례가 아니다.
      const hasInputAndOutput = counts.inputTokens !== null && counts.outputTokens !== null;
      return {
        ...counts,
        scope: 'MAIN_LOOP',
        status: !hasCounts
          ? 'MISSING'
          : terminal &&
              (!incomplete || finalCounts !== undefined) &&
              !interrupted &&
              hasInputAndOutput &&
              descriptor.reportableKeys.every((key) => counts[key] !== null)
            ? 'COMPLETE'
            : 'PARTIAL',
      };
    },
  };
};

export const createTokenUsageCollector = (runnerType: UsageSupportedRunner) =>
  createCollectorWithDescriptor(ENGINE_DESCRIPTORS[runnerType]);

// 테스트 전용. 보고 가능 집합·세션 정책의 일반화를 단언하기 위한 합성 서술 주입구다.
export const createTokenUsageCollectorWithDescriptor = (descriptor: TokenUsageEngineDescriptor) =>
  createCollectorWithDescriptor(descriptor);
