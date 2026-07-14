import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNNER_CAPABILITIES,
  describeUnsupportedRunnerOptions,
  getRunnerCapabilities,
  runnerSupportsEffort,
  runnerSupportsFastMode,
  runnerSupportsSubAgentDelegation,
} from './capabilities.js';

test('only claude-code and codex support fastMode', () => {
  assert.equal(RUNNER_CAPABILITIES.CLAUDE_CODE.fastMode, true);
  assert.equal(RUNNER_CAPABILITIES.CODEX.fastMode, true);
  assert.equal(RUNNER_CAPABILITIES.OPENCODE.fastMode, false);
  assert.equal(RUNNER_CAPABILITIES.ANTIGRAVITY.fastMode, false);
  assert.equal(RUNNER_CAPABILITIES.AMP.fastMode, false);
  assert.equal(RUNNER_CAPABILITIES.COPILOT_CLI.fastMode, false);
  assert.equal(runnerSupportsFastMode('CODEX'), true);
  assert.equal(runnerSupportsFastMode('OPENCODE'), false);
});

test('antigravity supports model selection', () => {
  assert.equal(RUNNER_CAPABILITIES.ANTIGRAVITY.model, true);
  assert.equal(RUNNER_CAPABILITIES.CLAUDE_CODE.model, true);
});

test('Copilot CLI supports model selection but not fast mode or sub-agent delegation', () => {
  assert.deepEqual(getRunnerCapabilities('COPILOT_CLI'), {
    model: true,
    fastMode: false,
    effort: false,
    subAgentDelegation: false,
  });
  assert.deepEqual(describeUnsupportedRunnerOptions('COPILOT_CLI', { model: 'gpt-5', fastMode: false }), []);
});

test('only claude-code supports background sub-agent delegation', () => {
  assert.equal(RUNNER_CAPABILITIES.CLAUDE_CODE.subAgentDelegation, true);
  assert.equal(RUNNER_CAPABILITIES.CODEX.subAgentDelegation, false);
  assert.equal(RUNNER_CAPABILITIES.OPENCODE.subAgentDelegation, false);
  assert.equal(RUNNER_CAPABILITIES.ANTIGRAVITY.subAgentDelegation, false);
  assert.equal(RUNNER_CAPABILITIES.AMP.subAgentDelegation, false);
  assert.equal(RUNNER_CAPABILITIES.COPILOT_CLI.subAgentDelegation, false);
  assert.equal(runnerSupportsSubAgentDelegation('CLAUDE_CODE'), true);
  assert.equal(runnerSupportsSubAgentDelegation('OPENCODE'), false);
});

test('unknown runner types default to no capabilities', () => {
  assert.deepEqual(getRunnerCapabilities('SOMETHING_ELSE'), {
    model: false,
    fastMode: false,
    effort: false,
    subAgentDelegation: false,
  });
  assert.equal(runnerSupportsFastMode('SOMETHING_ELSE'), false);
  assert.equal(runnerSupportsSubAgentDelegation('SOMETHING_ELSE'), false);
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

test('only claude-code and codex support effort', () => {
  assert.equal(RUNNER_CAPABILITIES.CLAUDE_CODE.effort, true);
  assert.equal(RUNNER_CAPABILITIES.CODEX.effort, true);
  assert.equal(RUNNER_CAPABILITIES.OPENCODE.effort, false);
  assert.equal(RUNNER_CAPABILITIES.ANTIGRAVITY.effort, false);
  assert.equal(RUNNER_CAPABILITIES.AMP.effort, false);
  assert.equal(RUNNER_CAPABILITIES.COPILOT_CLI.effort, false);
  assert.equal(runnerSupportsEffort('CODEX'), true);
  assert.equal(runnerSupportsEffort('CLAUDE_CODE'), true);
  assert.equal(runnerSupportsEffort('OPENCODE'), false);
  assert.equal(runnerSupportsEffort('SOMETHING_ELSE'), false);
});

test('describeUnsupportedRunnerOptions flags effort ignored for unsupported runners', () => {
  for (const runnerType of ['OPENCODE', 'ANTIGRAVITY', 'AMP', 'COPILOT_CLI']) {
    const warnings = describeUnsupportedRunnerOptions(runnerType, { model: null, fastMode: false, effort: 'high' });
    assert.equal(warnings.length, 1, `${runnerType} should warn once`);
    assert.equal(warnings[0]?.option, 'effort');
    assert.match(warnings[0]?.message ?? '', new RegExp(`Effort level is not supported by runner ${runnerType}`));
  }
});

test('describeUnsupportedRunnerOptions is silent for effort on supported runners and blank values', () => {
  assert.deepEqual(describeUnsupportedRunnerOptions('CODEX', { model: 'o4-mini', effort: 'high' }), []);
  assert.deepEqual(describeUnsupportedRunnerOptions('CLAUDE_CODE', { model: 'sonnet', effort: 'max' }), []);
  // blank/undefined effort on an unsupported runner must not warn.
  assert.deepEqual(describeUnsupportedRunnerOptions('OPENCODE', { model: 'gpt-5', effort: '   ' }), []);
  assert.deepEqual(describeUnsupportedRunnerOptions('OPENCODE', { model: 'gpt-5', effort: null }), []);
});
