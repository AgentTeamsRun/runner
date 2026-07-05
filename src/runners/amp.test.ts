import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAmpExecArgs, toPowerShellEncodedCommand } from './amp.js';

// AMP의 model → `--mode` 매핑은 의미 재검토 대상이다(amp.ts 주석 참조). 아래 스냅샷 테스트는
// 현행 매핑을 고정해, 계약 검증 전에 인자 조립이 무의식적으로 바뀌는 것을 막는다.

test('buildAmpExecArgs maps the requested model into the `--mode` flag (semantics under review)', () => {
  assert.deepEqual(buildAmpExecArgs('hello', 'gpt-5-codex'), [
    '--execute',
    'hello',
    '--dangerously-allow-all',
    '--stream-json-thinking',
    '--mode',
    'gpt-5-codex',
  ]);
});

test('buildAmpExecArgs omits `--mode` when no model is requested', () => {
  assert.deepEqual(buildAmpExecArgs('hello'), [
    '--execute',
    'hello',
    '--dangerously-allow-all',
    '--stream-json-thinking',
  ]);
  assert.deepEqual(buildAmpExecArgs('hello', null), [
    '--execute',
    'hello',
    '--dangerously-allow-all',
    '--stream-json-thinking',
  ]);
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

test('toPowerShellEncodedCommand mirrors the model → `--mode` mapping on the Windows path', () => {
  const script = decodePowerShellCommand(toPowerShellEncodedCommand('C:/amp.cmd', 'hello', 'gpt-5-codex'));
  assert.match(
    script,
    /'--execute' \$promptText '--dangerously-allow-all' '--stream-json-thinking' '--mode' 'gpt-5-codex'/,
  );
});

test('toPowerShellEncodedCommand omits `--mode` when no model is requested', () => {
  const script = decodePowerShellCommand(toPowerShellEncodedCommand('C:/amp.cmd', 'hello'));
  assert.match(script, /'--execute' \$promptText '--dangerously-allow-all' '--stream-json-thinking'/);
  assert.doesNotMatch(script, /--mode/);
});
