import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAmpExecArgs, toPowerShellEncodedCommand } from './amp.js';

// AmpCode만 AgentTeams의 model 스냅샷을 Amp CLI의 `--mode`로 전달한다(amp.ts 주석 참조).
// 아래 스냅샷 테스트는 이를 `--model`로 바꾸는 회귀를 막는다.

test('buildAmpExecArgs maps the requested model into the Amp `--mode` flag', () => {
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
