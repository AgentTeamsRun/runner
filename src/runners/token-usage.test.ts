import { createStreamJsonLineParser } from './stream-json-parser.js';
import { createOpenCodeJsonLineParser, createOpenCodeFinalTextCapturer } from './opencode-json-parser.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTokenUsageCollector, emptyTokenUsage, usageSupportedRunners } from './token-usage.js';

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
  assert.equal(emptyTokenUsage('CODEX').status, 'UNSUPPORTED');
  assert.equal(emptyTokenUsage('AMP').inputTokens, null);
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
