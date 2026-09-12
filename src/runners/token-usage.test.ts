import { createStreamJsonLineParser } from './stream-json-parser.js';
import { createOpenCodeJsonLineParser, createOpenCodeFinalTextCapturer } from './opencode-json-parser.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createTokenUsageCollector,
  createTokenUsageCollectorWithDescriptor,
  emptyTokenUsage,
  usageSupportedRunners,
} from './token-usage.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}-usage.jsonl`, import.meta.url), 'utf8');
const expected = {
  scope: 'MAIN_LOOP',
  status: 'COMPLETE',
  inputTokens: 150,
  outputTokens: 40,
  cacheReadInputTokens: 50,
  cacheCreationInputTokens: 10,
};
for (const [engine, name] of [
  ['CLAUDE_CODE', 'claude'],
  ['OPENCODE', 'opencode'],
] as const) {
  test(`${engine}: 버전 고정 fixture의 중복·분할 행은 한 번만 집계한다`, () => {
    const collector = createTokenUsageCollector(engine);
    for (const character of fixture(name)) collector.push(character);
    collector.flush();
    assert.deepEqual(collector.get(), expected);
    collector.push(fixture(name));
    collector.flush();
    assert.deepEqual(collector.get(), expected);
    assert.equal(collector.get(true).status, 'PARTIAL');
    assert.equal(collector.get(true).inputTokens, 150);
    assert.deepEqual(createTokenUsageCollector(engine).get(), emptyTokenUsage(engine));
  });
  test(`${engine}: 실패·취소 전에 수집한 부분 사용량을 보존한다`, () => {
    const collector = createTokenUsageCollector(engine);
    collector.push(fixture(name).split('\n').slice(0, 2).join('\n'));
    collector.flush();
    assert.deepEqual(collector.get(), {
      ...expected,
      status: 'PARTIAL',
      inputTokens: 100,
      outputTokens: engine === 'CLAUDE_CODE' ? null : 15,
      cacheReadInputTokens: 20,
    });
  });
}
test('Claude 최종 실패의 실제 0과 누락/비정상 수치를 구분한다', () => {
  const collector = createTokenUsageCollector('CLAUDE_CODE');
  const result = (usage: unknown) => JSON.stringify({ type: 'result', session_id: 'a', is_error: true, usage });
  collector.push(
    result({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  );
  collector.flush();
  assert.deepEqual(collector.get(), {
    ...expected,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  const invalid = createTokenUsageCollector('CLAUDE_CODE');
  invalid.push(result({ input_tokens: -1, output_tokens: 1.2, cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1 }));
  invalid.flush();
  assert.deepEqual(invalid.get(), emptyTokenUsage('CLAUDE_CODE'));
});
test('다른 세션과 하위 에이전트를 합산하지 않고 오염된 실행은 미수집 상태다', () => {
  const collector = createTokenUsageCollector('CLAUDE_CODE');
  collector.push(fixture('claude'));
  collector.push(fixture('claude').replaceAll('session-a', 'session-b'));
  assert.deepEqual(collector.get(), emptyTokenUsage('CLAUDE_CODE'));
  const child = createTokenUsageCollector('CLAUDE_CODE');
  child.push(
    fixture('claude').split('\n')[0]!.replace('"parent_tool_use_id":null', '"parent_tool_use_id":"child"') + '\n',
  );
  assert.equal(child.get().status, 'MISSING');
});
test('거대 행과 잘못된 JSON 뒤에서 수집을 재개하고 완전 수집을 주장하지 않는다', () => {
  const collector = createTokenUsageCollector('OPENCODE');
  collector.push('x'.repeat(1024 * 1024 + 1));
  collector.push('\nnull\n{broken}\n' + fixture('opencode'));
  assert.deepEqual(collector.get(), { ...expected, status: 'PARTIAL' });
});
test('미지원 엔진은 수집 누락과 다르다', () => {
  assert.equal(emptyTokenUsage('CURSOR_CLI').status, 'UNSUPPORTED');
  assert.equal(emptyTokenUsage('CURSOR_CLI').inputTokens, null);
  assert.equal(emptyTokenUsage('CODEX').status, 'MISSING');
  assert.equal(emptyTokenUsage('OMP').status, 'MISSING');
});

for (const [engine, name] of [
  ['CLAUDE_CODE', 'claude'],
  ['OPENCODE', 'opencode'],
] as const) {
  test(`${engine}: 이물 세션이 먼저 와도 어느 세션의 수치도 보고하지 않는다`, () => {
    const collector = createTokenUsageCollector(engine);
    collector.push(fixture(name).split('\n')[0]!.replaceAll('session-a', 'foreign') + '\n');
    collector.push(fixture(name));
    collector.flush();
    assert.deepEqual(collector.get(), emptyTokenUsage(engine));
  });
}

test('빈 parent_tool_use_id도 하위 에이전트로 제외한다', () => {
  const collector = createTokenUsageCollector('CLAUDE_CODE');
  collector.push(
    fixture('claude')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.stringify({ ...JSON.parse(line), parent_tool_use_id: '' }))
      .join('\n'),
  );
  collector.flush();
  assert.deepEqual(collector.get(), emptyTokenUsage('CLAUDE_CODE'));
});

test('지원 엔진 목록의 모든 엔진은 빈 수집기를 MISSING으로 보고한다', () => {
  for (const engine of usageSupportedRunners) {
    assert.equal(emptyTokenUsage(engine).status, 'MISSING');
    assert.deepEqual(createTokenUsageCollector(engine).get(), emptyTokenUsage(engine));
  }
});

test('Claude 최종 누적값은 유실된 앞선 행을 대체한다', () => {
  const collector = createTokenUsageCollector('CLAUDE_CODE');
  collector.push('x'.repeat(1024 * 1024 + 1) + '\n' + fixture('claude'));
  assert.deepEqual(collector.get(), expected);
});
test('OpenCode 오류 이벤트는 온전한 단계 합계를 불완전하게 만들지 않는다', () => {
  const collector = createTokenUsageCollector('OPENCODE');
  collector.push('{"type":"error"}\n' + fixture('opencode'));
  assert.deepEqual(collector.get(), expected);
});

for (const [engine, name, createParser] of [
  ['CLAUDE_CODE', 'claude', createStreamJsonLineParser],
  ['OPENCODE', 'opencode', createOpenCodeJsonLineParser],
] as const) {
  test(`${engine}: 로그와 사용량은 한 번 파싱한 이벤트를 공유한다`, (t) => {
    const collector = createTokenUsageCollector(engine);
    const capture = createOpenCodeFinalTextCapturer();
    const parser = createParser(() => {}, {
      onEvent: (event) => {
        collector.acceptEvent(event);
        capture.acceptEvent(event);
      },
      onDropped: collector.markDropped,
    });
    const text = fixture(name).trimEnd();
    const parse = t.mock.method(JSON, 'parse');
    for (const character of text) parser.push(character);
    parser.flush();
    parser.flush();
    assert.equal(parse.mock.callCount(), text.split('\n').length);
    assert.deepEqual(collector.get(), expected);
    parse.mock.restore();
  });
}

test('OpenCode 최종 텍스트도 같은 파싱 이벤트로 수집한다', () => {
  const capture = createOpenCodeFinalTextCapturer();
  const parser = createOpenCodeJsonLineParser(() => {}, { onEvent: capture.acceptEvent });
  parser.push('{"type":"text","part":{"type":"text","messageID":"a","text":"최종 결과"}}');
  parser.flush();
  assert.equal(capture.get(), '최종 결과');
});

test('세션 id 없는 사용량 이벤트는 별도 세션 이벤트로 확정되어 집계된다', () => {
  const collector = createTokenUsageCollectorWithDescriptor({
    reportableKeys: ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'],
    allowUsageWithoutSession: true,
    useSyntheticId: false,
    parse: (event) => {
      if (event.type === 'session-start') return { kind: 'session', sessionId: event.sid };
      if (event.type !== 'usage') return { kind: 'ignore' };
      const counts = event as Record<string, number>;
      return {
        kind: 'usage',
        counts: {
          inputTokens: counts.input,
          outputTokens: counts.output,
          cacheReadInputTokens: counts.cacheRead,
          cacheCreationInputTokens: counts.cacheWrite,
        },
        id: (event as Record<string, unknown>).stepId,
        terminal: (event as Record<string, unknown>).done === true,
      };
    },
  });
  // 세션을 아직 못 본 상태의 사용량 이벤트를 버리지 않는다(단일 프로세스 = 단일 세션).
  collector.acceptEvent({ type: 'usage', stepId: 's1', input: 100, output: 10, cacheRead: 20, cacheWrite: 5 });
  collector.acceptEvent({ type: 'session-start', sid: 'sess-1' });
  collector.acceptEvent({
    type: 'usage',
    stepId: 's2',
    input: 50,
    output: 30,
    cacheRead: 30,
    cacheWrite: 5,
    done: true,
  });
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 150,
    outputTokens: 40,
    cacheReadInputTokens: 50,
    cacheCreationInputTokens: 10,
  });
});

test('보고 가능 집합에 없는 필드가 null이어도 종료 근거가 있으면 COMPLETE다', () => {
  const collector = createTokenUsageCollectorWithDescriptor({
    reportableKeys: ['inputTokens', 'outputTokens', 'cacheReadInputTokens'],
    allowUsageWithoutSession: false,
    useSyntheticId: false,
    parse: (event) => {
      if (event.type !== 'usage') return { kind: 'ignore' };
      const counts = event as Record<string, number>;
      return {
        kind: 'usage',
        sessionId: (event as Record<string, unknown>).sid,
        counts: {
          inputTokens: counts.input,
          outputTokens: counts.output,
          cacheReadInputTokens: counts.cacheRead,
          cacheCreationInputTokens: null,
        },
        id: (event as Record<string, unknown>).stepId,
        terminal: (event as Record<string, unknown>).done === true,
      };
    },
  });
  collector.acceptEvent({
    type: 'usage',
    sid: 'sess-1',
    stepId: 's1',
    input: 150,
    output: 40,
    cacheRead: 50,
    done: true,
  });
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 150,
    outputTokens: 40,
    cacheReadInputTokens: 50,
    cacheCreationInputTokens: null,
  });
});

const codexFixture = () => readFileSync(new URL('./fixtures/codex-events.jsonl', import.meta.url), 'utf8');

test('CODEX: turn.completed 사용량을 계약대로 매핑한다', () => {
  const collector = createTokenUsageCollector('CODEX');
  for (const character of codexFixture()) collector.push(character);
  collector.flush();
  // input_tokens(78699)는 캐시 읽기분(57600)을 포함하므로 계약상 입력은 차감값이다.
  // output_tokens(292)는 추론 출력(15)을 이미 포함하므로 더하지 않는다.
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 21099,
    outputTokens: 292,
    cacheReadInputTokens: 57600,
    cacheCreationInputTokens: null,
  });
});

test('CODEX: 세션 시작만으로는 사용량이 없다', () => {
  const collector = createTokenUsageCollector('CODEX');
  collector.push(`${codexFixture().split('\n')[0]}\n`);
  collector.flush();
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'MISSING',
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  });
});

const ompFixture = () => readFileSync(new URL('./fixtures/omp-events.jsonl', import.meta.url), 'utf8');

test('OMP: assistant message_end 4건의 합이 나오고 COMPLETE다', () => {
  const collector = createTokenUsageCollector('OMP');
  for (const character of ompFixture()) collector.push(character);
  collector.flush();
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 13165,
    outputTokens: 253,
    cacheReadInputTokens: 71680,
    cacheCreationInputTokens: 0,
  });
});

test('OMP: reasoningTokens를 output에 더하지 않는다', () => {
  const collector = createTokenUsageCollector('OMP');
  for (const character of ompFixture()) collector.push(character);
  collector.flush();
  // 4건 output 단순 합 191+29+24+9=253. reasoning 103을 더한 356이 아니다.
  // 근거: input + cacheRead + output = totalTokens 항등식.
  assert.equal(collector.get().outputTokens, 253);
});

test('OMP: user·toolResult message_end는 집계에 포함되지 않는다', () => {
  const collector = createTokenUsageCollector('OMP');
  collector.acceptEvent({ type: 'session', version: 3, id: 'sess-omp-1' });
  collector.acceptEvent({ type: 'message_end', message: { role: 'user', content: [] } });
  collector.acceptEvent({ type: 'message_end', message: { role: 'toolResult', content: [] } });
  collector.acceptEvent({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1 } },
  });
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 1,
  });
});

const grokFixture = () => readFileSync(new URL('./fixtures/grok-usage.jsonl', import.meta.url), 'utf8');

test('GROK_BUILD: result 누적값이 나오고 COMPLETE다', () => {
  const collector = createTokenUsageCollector('GROK_BUILD');
  for (const character of grokFixture()) collector.push(character);
  collector.flush();
  // 실측 수치(2026-09-08, grok 1.0.13): result.usage가 assistant 2건 합과 일치한다.
  // 입력 8343+3075=11418, 출력 84+59=143, 캐시 읽기 6272+11648=17920.
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 11418,
    outputTokens: 143,
    cacheReadInputTokens: 17920,
    cacheCreationInputTokens: 0,
  });
});

test('GROK_BUILD: 중복 행은 한 번만 집계하고 result 전에는 출력이 없다', () => {
  const collector = createTokenUsageCollector('GROK_BUILD');
  collector.push(grokFixture().split('\n').slice(0, 2).join('\n'));
  collector.flush();
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'PARTIAL',
    inputTokens: 8343,
    outputTokens: null,
    cacheReadInputTokens: 6272,
    cacheCreationInputTokens: 0,
  });
});

test('GROK_BUILD: modelUsage 분해는 무시하고 usage 네 필드만 읽는다', () => {
  const collector = createTokenUsageCollector('GROK_BUILD');
  collector.acceptEvent({
    type: 'result',
    session_id: 'session-grok-a',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 1,
    },
    modelUsage: { 'grok-4.6-build': { inputTokens: 999, outputTokens: 999 } },
  });
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 1,
  });
});

const copilotFixture = () => readFileSync(new URL('./fixtures/copilot-events.jsonl', import.meta.url), 'utf8');

test('COPILOT_CLI: 출력 토큰만 합산하고 PARTIAL이 상한이다', () => {
  const collector = createTokenUsageCollector('COPILOT_CLI');
  for (const character of copilotFixture()) collector.push(character);
  collector.flush();
  // assistant.message 3건의 outputTokens 합 428+253+17=698. 입력·캐시는 엔진이
  // 제공하지 않아 null이며, 입력 부재 상한에 따라 종료 근거가 있어도 PARTIAL이다.
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'PARTIAL',
    inputTokens: null,
    outputTokens: 698,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  });
});

test('COPILOT_CLI: 같은 messageId는 한 번만 계산한다', () => {
  const collector = createTokenUsageCollector('COPILOT_CLI');
  const line = JSON.stringify({ type: 'assistant.message', data: { messageId: 'm-1', outputTokens: 100 } });
  collector.push(`${line}\n${line}\n`);
  collector.push(JSON.stringify({ type: 'result', sessionId: 'sess-1', exitCode: 0 }) + '\n');
  collector.flush();
  assert.equal(collector.get().outputTokens, 100);
  assert.equal(collector.get().status, 'PARTIAL');
});

test('COPILOT_CLI: 출력만 있는 수집기는 입력 상한 때문에 COMPLETE가 되지 않는다', () => {
  const collector = createTokenUsageCollector('COPILOT_CLI');
  collector.acceptEvent({ type: 'assistant.message', data: { messageId: 'm-1', outputTokens: 10 } });
  collector.acceptEvent({ type: 'result', sessionId: 'sess-1', exitCode: 0 });
  const usage = collector.get();
  assert.equal(usage.outputTokens, 10);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.status, 'PARTIAL');
});

const ampFixture = () => fixture('amp');

test('AMP: assistant 메시지별 네 필드를 합산하고 end_turn에서 완결된다', () => {
  const collector = createTokenUsageCollector('AMP');
  const parser = createStreamJsonLineParser(() => {}, {
    onEvent: collector.acceptEvent,
    onDropped: collector.markDropped,
  });
  for (const character of ampFixture()) parser.push(character);
  parser.flush();
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'COMPLETE',
    inputTokens: 0,
    outputTokens: 98,
    cacheReadInputTokens: 40081,
    cacheCreationInputTokens: 40370,
  });
  assert.equal(collector.get(true).status, 'PARTIAL');
  collector.markDropped();
  assert.equal(collector.get().status, 'PARTIAL');
});

test('AMP: 중간 사용량을 보존하고 수치 없는 result로 완결성을 올리지 않는다', () => {
  const collector = createTokenUsageCollector('AMP');
  const lines = ampFixture().trim().split('\n');
  collector.push(lines[0]! + '\n' + lines[2]! + '\n');
  assert.deepEqual(collector.get(), {
    scope: 'MAIN_LOOP',
    status: 'PARTIAL',
    inputTokens: 0,
    outputTokens: 77,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 40084,
  });
});

test('AMP: 합성 순번은 중복 행을 제거하지 못하고 다른 세션은 무효화한다', () => {
  const collector = createTokenUsageCollector('AMP');
  collector.push(ampFixture());
  collector.push(ampFixture());
  assert.equal(collector.get().outputTokens, 196);
  collector.acceptEvent({ type: 'result', session_id: 'foreign' });
  assert.equal(collector.get().status, 'MISSING');
  const child = createTokenUsageCollector('AMP');
  child.push(ampFixture().split('\n')[0]!.replace('"parent_tool_use_id":null', '"parent_tool_use_id":"child"') + '\n');
  assert.equal(child.get().status, 'MISSING');
});
