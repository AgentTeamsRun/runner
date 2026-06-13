import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex.js';
import { createRunnerFactory } from './index.js';
import { OpenCodeRunner } from './opencode.js';
import { AntigravityRunner } from './antigravity.js';

test('createRunnerFactory returns the expected runner implementations', () => {
  const createRunner = createRunnerFactory('custom-opencode');

  assert.equal(createRunner('OPENCODE') instanceof OpenCodeRunner, true);
  assert.equal(createRunner('CLAUDE_CODE') instanceof ClaudeCodeRunner, true);
  assert.equal(createRunner('CODEX') instanceof CodexRunner, true);
  assert.equal(createRunner('ANTIGRAVITY') instanceof AntigravityRunner, true);
});

test('createRunnerFactory throws for unsupported runner types', () => {
  const createRunner = createRunnerFactory('custom-opencode');
  assert.throws(() => createRunner('UNKNOWN'), /Unsupported runner type: UNKNOWN/);
});
