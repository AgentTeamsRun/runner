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
