import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCauseBearingResultMessage,
  selectPreferredFailureMessage,
  selectRunnerFailureMessage,
} from './failure-message.js';

const cases = [
  {
    name: 'returns undefined for a successful exit',
    options: { exitCode: 0, lastErrorOutput: 'ignored error', lastOutput: 'ignored output' },
    expected: undefined,
  },
  {
    name: 'prefers the trimmed error-channel output',
    options: { exitCode: 1, lastErrorOutput: '  specific error  ', lastOutput: 'general output' },
    expected: 'specific error',
  },
  {
    name: 'falls back to trimmed general output',
    options: { exitCode: 2, lastErrorOutput: ' \n ', lastOutput: '  general output  ' },
    expected: 'general output',
  },
  {
    name: 'ignores whitespace-only output and returns the exit code',
    options: { exitCode: 3, lastErrorOutput: '\t', lastOutput: '\n' },
    expected: 'Runner exited with code 3',
  },
  {
    name: 'returns the exit code when no output was captured',
    options: { exitCode: 4, lastErrorOutput: '', lastOutput: '' },
    expected: 'Runner exited with code 4',
  },
  {
    name: 'uses exit code 1 when the process exit code is null',
    options: { exitCode: null, lastErrorOutput: '', lastOutput: '' },
    expected: 'Runner exited with code 1',
  },
] as const;

for (const { name, options, expected } of cases) {
  test(name, () => {
    assert.equal(selectRunnerFailureMessage(options), expected);
  });
}

const causeBearingCases = [
  {
    name: 'codex의 `[Result] Failed: <사유>`는 원인으로 인정한다',
    message: "[Result] Failed: The 'gpt-5' model is not supported",
    expected: true,
  },
  {
    name: 'claude 계열의 `[Result] Error after ...: <사유>`는 원인으로 인정한다',
    message: '[Result] Error after 12s (3 turns): rate limit exceeded',
    expected: true,
  },
  { name: '`[Result] Failed` 단독 마커는 원인으로 보지 않는다', message: '[Result] Failed', expected: false },
  {
    name: '요약만 붙은 `[Result] Failed (12s, 3 files changed)`는 원인으로 보지 않는다',
    message: '[Result] Failed (12s, 3 files changed)',
    expected: false,
  },
  { name: '`[Result] Failed in 12s`는 원인으로 보지 않는다', message: '[Result] Failed in 12s', expected: false },
  { name: '콜론 뒤가 비어 있으면 원인으로 보지 않는다', message: '[Result] Failed:   ', expected: false },
  { name: '성공 마커는 원인으로 보지 않는다', message: '[Result] Completed in 12s (3 turns)', expected: false },
  { name: 'RESULT 머리말이 아니면 원인으로 보지 않는다', message: '[Tool] bash: failed', expected: false },
] as const;

for (const { name, message, expected } of causeBearingCases) {
  test(`isCauseBearingResultMessage: ${name}`, () => {
    assert.equal(isCauseBearingResultMessage(message), expected);
  });
}

test('selectPreferredFailureMessage: 원인이 담긴 RESULT 원문이 stderr 마지막 줄을 이긴다', () => {
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: "[Result] Failed: The 'gpt-5' model is not supported with the Responses API",
      runnerErrorMessage: 'Reading additional input from stdin...',
      lastOutput: 'general output',
      exitCode: 1,
    }),
    "[Result] Failed: The 'gpt-5' model is not supported with the Responses API",
  );
});

test('selectPreferredFailureMessage: 원인 없는 RESULT 마커면 기존 stderr 값이 유지된다', () => {
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: '[Result] Failed (12s, 3 files changed)',
      runnerErrorMessage: 'Reading additional input from stdin...',
      lastOutput: 'general output',
      exitCode: 1,
    }),
    'Reading additional input from stdin...',
  );
});

test('selectPreferredFailureMessage: idle 타임아웃 문구는 RESULT 원문으로 덮어쓰지 않는다', () => {
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: "[Result] Failed: The 'gpt-5' model is not supported",
      runnerErrorMessage: 'Runner idle timed out after 10m of no output',
      lastOutput: 'general output',
      exitCode: 1,
      idleTimedOut: true,
    }),
    'Runner idle timed out after 10m of no output',
  );
});

test('selectPreferredFailureMessage: RESULT 원문이 여러 개면 마지막 값이 이긴다', () => {
  const chunks = ['[Result] Failed: first failure', '[Result] Completed in 3s', '[Result] Failed: last failure wins'];
  const lastCause = chunks.filter(isCauseBearingResultMessage).at(-1);

  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: lastCause,
      runnerErrorMessage: 'stderr tail',
      lastOutput: 'general output',
      exitCode: 1,
    }),
    '[Result] Failed: last failure wins',
  );
});

test('selectPreferredFailureMessage: RESULT 원문이 없으면 stderr → lastOutput → 종료 코드 순으로 내려간다', () => {
  assert.equal(
    selectPreferredFailureMessage({ runnerErrorMessage: '  stderr tail  ', lastOutput: 'general output', exitCode: 1 }),
    'stderr tail',
  );
  assert.equal(
    selectPreferredFailureMessage({ runnerErrorMessage: '  ', lastOutput: '  general output  ', exitCode: 2 }),
    'general output',
  );
  assert.equal(selectPreferredFailureMessage({ exitCode: 3 }), 'Runner exited with code 3');
  assert.equal(selectPreferredFailureMessage({ exitCode: null }), 'Runner exited with code 1');
});

test('selectPreferredFailureMessage: idle 타임아웃인데 러너 문구가 없으면 남은 후보로 내려간다', () => {
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: '[Result] Failed: ignored while idle timed out',
      runnerErrorMessage: '',
      lastOutput: 'general output',
      exitCode: 1,
      idleTimedOut: true,
    }),
    'general output',
  );
});

test('selectPreferredFailureMessage: fail-safe 타임아웃 문구도 RESULT 원문으로 덮어쓰지 않는다', () => {
  // 러너들은 fail-safe 워치독에 죽을 때 `idleTimedOut`을 세우지 않고 `timedOut`만 true로 돌려준다.
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: '[Result] Failed: a cause emitted long before the watchdog fired',
      runnerErrorMessage: 'Runner fail-safe timed out after 6h',
      lastOutput: 'general output',
      exitCode: 1,
      timedOut: true,
    }),
    'Runner fail-safe timed out after 6h',
  );
});

test('selectPreferredFailureMessage: fail-safe 타임아웃인데 러너 문구가 없으면 남은 후보로 내려간다', () => {
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: '[Result] Failed: ignored while the watchdog fired',
      runnerErrorMessage: '   ',
      lastOutput: 'general output',
      exitCode: 1,
      timedOut: true,
    }),
    'general output',
  );
});

test('selectPreferredFailureMessage: 타임아웃이 아니면 RESULT 원문이 러너 문구를 이긴다', () => {
  assert.equal(
    selectPreferredFailureMessage({
      resultFailureDetail: '[Result] Failed: the real cause',
      runnerErrorMessage: 'Reading additional input from stdin...',
      lastOutput: 'general output',
      exitCode: 1,
      timedOut: false,
    }),
    '[Result] Failed: the real cause',
  );
});
