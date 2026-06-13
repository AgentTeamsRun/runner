import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeCodeArgs, extractResultTextFromStreamJson } from './claude-code.js';

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
