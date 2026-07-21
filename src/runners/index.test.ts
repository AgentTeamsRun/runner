import assert from 'node:assert/strict';
import test from 'node:test';
import { RUNNER_TYPES } from '@agentteams/core-constants';
import { AmpCodeRunner } from './amp.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex.js';
import { createRunnerFactory } from './index.js';
import { OpenCodeRunner } from './opencode.js';
import { AntigravityRunner } from './antigravity.js';
import { CopilotCliRunner } from './copilot-cli.js';
import { CursorCliRunner } from './cursor-cli.js';
import { KimiCliRunner } from './kimi-cli.js';

test('createRunnerFactory returns the expected runner implementations', () => {
  const createRunner = createRunnerFactory('custom-opencode');

  assert.equal(createRunner('OPENCODE') instanceof OpenCodeRunner, true);
  assert.equal(createRunner('CLAUDE_CODE') instanceof ClaudeCodeRunner, true);
  assert.equal(createRunner('CODEX') instanceof CodexRunner, true);
  assert.equal(createRunner('ANTIGRAVITY') instanceof AntigravityRunner, true);
  assert.equal(createRunner('AMP') instanceof AmpCodeRunner, true);
  assert.equal(createRunner('COPILOT_CLI') instanceof CopilotCliRunner, true);
  assert.equal(createRunner('CURSOR_CLI') instanceof CursorCliRunner, true);
  assert.equal(createRunner('KIMI_CLI') instanceof KimiCliRunner, true);
});

// SSOT(@agentteams/core-constants)와 factory가 처리하는 러너 타입 집합이 정확히
// 일치하는지 런타임에서 검증한다. SSOT에 값이 추가/삭제되면 이 테스트가 실패한다.
// (역방향 — factory가 SSOT 외 값을 case로 갖는 것 — 은 index.ts의 컴파일 타임 exhaustive 가드가 막는다.)
test('createRunnerFactory handles exactly the SSOT runner types', () => {
  const createRunner = createRunnerFactory('custom-opencode');

  for (const runnerType of Object.values(RUNNER_TYPES)) {
    assert.doesNotThrow(
      () => createRunner(runnerType),
      `SSOT runner type "${runnerType}" should be handled by the factory`,
    );
  }
});

test('createRunnerFactory throws for unsupported runner types', () => {
  const createRunner = createRunnerFactory('custom-opencode');
  assert.throws(() => createRunner('UNKNOWN'), /Unsupported runner type: UNKNOWN/);
});
