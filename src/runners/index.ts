import { OpenCodeRunner } from './opencode.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex.js';
import { AmpCodeRunner } from './amp.js';
import { AntigravityRunner } from './antigravity.js';
import type { Runner } from './types.js';

export const createRunnerFactory = (runnerCmd: string) => {
  return (runnerType: string): Runner => {
    switch (runnerType) {
      case 'OPENCODE':
        return new OpenCodeRunner(runnerCmd);
      case 'CLAUDE_CODE':
        return new ClaudeCodeRunner();
      case 'CODEX':
        return new CodexRunner();
      case 'ANTIGRAVITY':
        return new AntigravityRunner();
      case 'AMP':
        return new AmpCodeRunner();
      // TODO: AIDER
      // TODO: GOOSE
      // TODO: PLANDEX
      default:
        throw new Error(`Unsupported runner type: ${runnerType}`);
    }
  };
};
