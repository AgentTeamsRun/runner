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

export const usageSupportedRunners = ['CLAUDE_CODE', 'OPENCODE'] as const;
type UsageSupportedRunner = (typeof usageSupportedRunners)[number];

export const emptyTokenUsage = (runnerType: string): TokenUsage => ({
  ...empty(),
  scope: 'MAIN_LOOP',
  status: usageSupportedRunners.some((supported) => supported === runnerType) ? 'MISSING' : 'UNSUPPORTED',
});

// 원문은 보존하지 않는다. 행 버퍼와 중복 제거 표를 제한해 잘못된 출력이 실행을 실패시키지 않게 한다.
export const createTokenUsageCollector = (runnerType: UsageSupportedRunner) => {
  let incomplete = false;
  let invalidSession = false;
  let session: string | undefined;
  let terminal = false;
  let finalCounts: Counts | undefined;
  const steps = new Map<string, Counts>();
  const acceptSession = (value: unknown): boolean => {
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
    let id: unknown;
    let counts: Counts;
    if (runnerType === 'CLAUDE_CODE') {
      if (event.type !== 'assistant' && event.type !== 'result') return;
      if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return;
      if (!acceptSession(event.session_id)) return;
      const message = record(event.message);
      const usage = record(event.type === 'result' ? event.usage : message.usage);
      counts = {
        inputTokens: count(usage.input_tokens),
        outputTokens: event.type === 'result' ? count(usage.output_tokens) : null,
        cacheReadInputTokens: count(usage.cache_read_input_tokens),
        cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
      };
      if (event.type === 'result') {
        // 최종 누적값은 부분 합계에 더하지 않는다. 누락 필드만 기존 부분값을 보존한다.
        const previous = aggregate();
        finalCounts = Object.fromEntries(keys.map((key) => [key, counts[key] ?? previous[key]])) as Counts;
        terminal = keys.every((key) => counts[key] !== null);
        return;
      }
      id = message.id;
    } else {
      const part = record(event.part);
      if (event.type === 'error') return;
      if (part.type !== 'step-finish') return;
      if (!acceptSession(event.sessionID) || (part.sessionID !== undefined && part.sessionID !== session)) {
        invalidSession = true;
        return;
      }
      const tokens = record(part.tokens);
      const cache = record(tokens.cache);
      counts = {
        inputTokens: count(tokens.input),
        outputTokens: add(count(tokens.output), count(tokens.reasoning)),
        cacheReadInputTokens: count(cache.read),
        cacheCreationInputTokens: count(cache.write),
      };
      id = part.id;
      terminal = part.reason === 'stop';
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
      incomplete = true;
      return;
    }
    if (!steps.has(id) && steps.size >= 10000) {
      incomplete = true;
      return;
    }
    steps.set(id, counts);
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
      return {
        ...counts,
        scope: 'MAIN_LOOP',
        status: !hasCounts
          ? 'MISSING'
          : terminal &&
              (!incomplete || finalCounts !== undefined) &&
              !interrupted &&
              keys.every((key) => counts[key] !== null)
            ? 'COMPLETE'
            : 'PARTIAL',
      };
    },
  };
};
