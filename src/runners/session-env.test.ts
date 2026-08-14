import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentTeamsSessionEnv, buildRunnerChildEnv } from './session-env.js';
import type { RunnerOptions } from './types.js';

const baseOptions = (overrides: Partial<RunnerOptions> = {}): RunnerOptions => ({
  triggerId: 'trigger-1',
  prompt: 'do the thing',
  authPath: '/tmp/project',
  apiKey: 'key_test',
  apiUrl: 'https://api.example.test',
  teamId: 'team-1',
  projectId: 'project-1',
  timeoutMs: 1000,
  idleTimeoutMs: 500,
  agentConfigId: 'agent-1',
  runnerType: 'CLAUDE_CODE',
  ...overrides,
});

test('carries the existing session variables unchanged', () => {
  const env = buildAgentTeamsSessionEnv(baseOptions());

  assert.equal(env.AGENTTEAMS_API_KEY, 'key_test');
  assert.equal(env.AGENTTEAMS_API_URL, 'https://api.example.test');
  assert.equal(env.AGENTTEAMS_TEAM_ID, 'team-1');
  assert.equal(env.AGENTTEAMS_PROJECT_ID, 'project-1');
  assert.equal(env.AGENTTEAMS_AGENT_NAME, 'agent-1');
});

test('exports all three execution snapshot variables when every value is present', () => {
  const env = buildAgentTeamsSessionEnv(baseOptions({ model: 'claude-opus-5', fastMode: true }));

  assert.equal(env.AGENTTEAMS_RUNNER_TYPE, 'CLAUDE_CODE');
  assert.equal(env.AGENTTEAMS_MODEL, 'claude-opus-5');
  assert.equal(env.AGENTTEAMS_FAST_MODE, 'true');
});

test('omits the model variable when the model is absent', () => {
  for (const model of [undefined, null, '', '   ']) {
    const env = buildAgentTeamsSessionEnv(baseOptions({ model }));

    assert.equal('AGENTTEAMS_MODEL' in env, false, `model=${JSON.stringify(model)} should omit the key`);
  }
});

test('omits the fast mode variable unless fast mode is on', () => {
  for (const fastMode of [undefined, false]) {
    const env = buildAgentTeamsSessionEnv(baseOptions({ fastMode }));

    assert.equal('AGENTTEAMS_FAST_MODE' in env, false, `fastMode=${String(fastMode)} should omit the key`);
  }
});

test('omits the runner type variable when the runner type is blank', () => {
  const env = buildAgentTeamsSessionEnv(baseOptions({ runnerType: '  ' as RunnerOptions['runnerType'] }));

  assert.equal('AGENTTEAMS_RUNNER_TYPE' in env, false);
});

test('trims surrounding whitespace instead of exporting padded values', () => {
  const env = buildAgentTeamsSessionEnv(baseOptions({ model: '  gpt-5-codex  ' }));

  assert.equal(env.AGENTTEAMS_MODEL, 'gpt-5-codex');
});

test('drops a stale inherited execution snapshot when the current run has no such value', () => {
  const parentEnv = {
    PATH: '/usr/bin',
    AGENTTEAMS_RUNNER_TYPE: 'STALE_RUNNER',
    AGENTTEAMS_MODEL: 'stale-model',
    AGENTTEAMS_FAST_MODE: 'true',
  };

  const env = buildRunnerChildEnv(parentEnv, baseOptions({ model: null, fastMode: false }));

  assert.equal('AGENTTEAMS_MODEL' in env, false);
  assert.equal('AGENTTEAMS_FAST_MODE' in env, false);
  // 현재 실행에 존재하는 값은 부모 값을 덮어써야 한다.
  assert.equal(env.AGENTTEAMS_RUNNER_TYPE, 'CLAUDE_CODE');
  // 스냅샷 축과 무관한 부모 환경은 그대로 상속된다.
  assert.equal(env.PATH, '/usr/bin');
});

test('keeps the current execution snapshot when the parent has none', () => {
  const env = buildRunnerChildEnv({ PATH: '/usr/bin' }, baseOptions({ model: 'claude-opus-5', fastMode: true }));

  assert.equal(env.AGENTTEAMS_RUNNER_TYPE, 'CLAUDE_CODE');
  assert.equal(env.AGENTTEAMS_MODEL, 'claude-opus-5');
  assert.equal(env.AGENTTEAMS_FAST_MODE, 'true');
  assert.equal(env.AGENTTEAMS_API_KEY, 'key_test');
});

test('drops a stale runner type when the current run has none', () => {
  const env = buildRunnerChildEnv(
    { AGENTTEAMS_RUNNER_TYPE: 'STALE_RUNNER' },
    baseOptions({ runnerType: '  ' as RunnerOptions['runnerType'] }),
  );

  assert.equal('AGENTTEAMS_RUNNER_TYPE' in env, false);
});
