import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeCodeArgs, buildClaudeCodeEnv, extractResultTextFromStreamJson } from './claude-code.js';

test('buildClaudeCodeArgs enables stream-json mode with verbose output', () => {
  assert.deepEqual(buildClaudeCodeArgs('claude-sonnet'), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model',
    'claude-sonnet',
  ]);
});

test('buildClaudeCodeArgs omits the model flag when no model is provided', () => {
  assert.deepEqual(buildClaudeCodeArgs(null), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ]);
});

test('buildClaudeCodeArgs injects fast mode settings', () => {
  assert.deepEqual(buildClaudeCodeArgs('claude-opus-4-7', true), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--settings',
    '{"fastMode":true}',
    '--model',
    'claude-opus-4-7',
  ]);
});

test('buildClaudeCodeEnv preserves background delegation when the parent disables it', () => {
  const env = buildClaudeCodeEnv(
    {
      PATH: '/usr/bin',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      AGENTTEAMS_API_URL: 'https://stale.example.com',
    },
    {
      AGENTTEAMS_API_URL: 'https://api.example.com',
      AGENTTEAMS_API_KEY: 'runner-key',
    },
  );

  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.AGENTTEAMS_API_URL, 'https://api.example.com');
  assert.equal(env.AGENTTEAMS_API_KEY, 'runner-key');
});

test('extractResultTextFromStreamJson returns the final result payload', () => {
  const output = [
    '{"type":"message_start"}',
    '{"type":"content_block_delta","delta":"thinking"}',
    '{"type":"result","result":"Final answer"}',
  ].join('\n');

  assert.equal(extractResultTextFromStreamJson(output), 'Final answer');
});

test('extractResultTextFromStreamJson falls back to raw output when result parsing fails', () => {
  const output = ['{"type":"message_start"}', '{"type":"result","result":'].join('\n');

  assert.equal(extractResultTextFromStreamJson(output), output);
});

test('buildClaudeCodeArgs injects the --effort flag with the requested level', () => {
  assert.deepEqual(buildClaudeCodeArgs('claude-sonnet-5', false, 'high'), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--effort',
    'high',
    '--model',
    'claude-sonnet-5',
  ]);
});

test('buildClaudeCodeArgs keeps both fast mode settings and the --effort flag when combined', () => {
  const args = buildClaudeCodeArgs('claude-opus-4-8', true, 'max');
  assert.ok(args.includes('--settings'));
  assert.ok(args.includes('{"fastMode":true}'));
  const effortIndex = args.indexOf('--effort');
  assert.notEqual(effortIndex, -1);
  assert.equal(args[effortIndex + 1], 'max');
});

test('buildClaudeCodeArgs omits the --effort flag when effort is missing or blank', () => {
  assert.equal(buildClaudeCodeArgs('claude-sonnet-5', false).includes('--effort'), false);
  assert.equal(buildClaudeCodeArgs('claude-sonnet-5', false, '   ').includes('--effort'), false);
});

test('buildClaudeCodeEnv strips CLAUDE_CODE_EFFORT_LEVEL only when an effort is requested', () => {
  const withEffort = buildClaudeCodeEnv(
    { PATH: '/usr/bin', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    { AGENTTEAMS_API_KEY: 'runner-key' },
    { effortRequested: true },
  );
  assert.equal(withEffort.CLAUDE_CODE_EFFORT_LEVEL, undefined);

  const withoutEffort = buildClaudeCodeEnv(
    { PATH: '/usr/bin', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    { AGENTTEAMS_API_KEY: 'runner-key' },
    { effortRequested: false },
  );
  assert.equal(withoutEffort.CLAUDE_CODE_EFFORT_LEVEL, 'max');

  const defaultOptions = buildClaudeCodeEnv(
    { PATH: '/usr/bin', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    { AGENTTEAMS_API_KEY: 'runner-key' },
  );
  assert.equal(defaultOptions.CLAUDE_CODE_EFFORT_LEVEL, 'max');
});
