import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNNER_CAPABILITIES,
  describeUnsupportedRunnerOptions,
  getRunnerCapabilities,
  runnerSupportsFastMode,
} from './capabilities.js';

test('only claude-code and codex support fastMode', () => {
  assert.equal(RUNNER_CAPABILITIES.CLAUDE_CODE.fastMode, true);
  assert.equal(RUNNER_CAPABILITIES.CODEX.fastMode, true);
  assert.equal(RUNNER_CAPABILITIES.OPENCODE.fastMode, false);
  assert.equal(RUNNER_CAPABILITIES.ANTIGRAVITY.fastMode, false);
  assert.equal(RUNNER_CAPABILITIES.AMP.fastMode, false);
  assert.equal(runnerSupportsFastMode('CODEX'), true);
  assert.equal(runnerSupportsFastMode('OPENCODE'), false);
});

test('antigravity supports model selection', () => {
  assert.equal(RUNNER_CAPABILITIES.ANTIGRAVITY.model, true);
  assert.equal(RUNNER_CAPABILITIES.CLAUDE_CODE.model, true);
});

test('unknown runner types default to no capabilities', () => {
  assert.deepEqual(getRunnerCapabilities('SOMETHING_ELSE'), { model: false, fastMode: false });
  assert.equal(runnerSupportsFastMode('SOMETHING_ELSE'), false);
});

test('describeUnsupportedRunnerOptions is silent for ANTIGRAVITY model selection', () => {
  const warnings = describeUnsupportedRunnerOptions('ANTIGRAVITY', { model: 'gemini-3', fastMode: false });
  assert.deepEqual(warnings, []);
});

test('describeUnsupportedRunnerOptions flags fastMode ignored for unsupported runners', () => {
  for (const runnerType of ['OPENCODE', 'ANTIGRAVITY', 'AMP']) {
    const warnings = describeUnsupportedRunnerOptions(runnerType, { model: null, fastMode: true });
    assert.equal(warnings.length, 1, `${runnerType} should warn once`);
    assert.equal(warnings[0]?.option, 'fastMode');
    assert.match(warnings[0]?.message ?? '', new RegExp(`Fast mode is not supported by runner ${runnerType}`));
  }
});

test('describeUnsupportedRunnerOptions reports only fastMode for ANTIGRAVITY model plus fastMode', () => {
  const warnings = describeUnsupportedRunnerOptions('ANTIGRAVITY', { model: 'gemini-3', fastMode: true });
  assert.deepEqual(
    warnings.map((w) => w.option),
    ['fastMode'],
  );
});

test('describeUnsupportedRunnerOptions is silent for supported combinations', () => {
  assert.deepEqual(describeUnsupportedRunnerOptions('CODEX', { model: 'o4-mini', fastMode: true }), []);
  assert.deepEqual(describeUnsupportedRunnerOptions('CLAUDE_CODE', { model: 'sonnet', fastMode: true }), []);
  assert.deepEqual(describeUnsupportedRunnerOptions('ANTIGRAVITY', { model: 'gemini-3', fastMode: false }), []);
  // opencode supports model but not fastMode → only fastMode warns; model alone is silent.
  assert.deepEqual(describeUnsupportedRunnerOptions('OPENCODE', { model: 'gpt-5', fastMode: false }), []);
});

test('describeUnsupportedRunnerOptions ignores blank model values', () => {
  assert.deepEqual(describeUnsupportedRunnerOptions('ANTIGRAVITY', { model: '   ', fastMode: false }), []);
  assert.deepEqual(describeUnsupportedRunnerOptions('ANTIGRAVITY', { model: null, fastMode: false }), []);
});
