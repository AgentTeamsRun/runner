import { OpenCodeRunner } from './opencode.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex.js';
import { AmpCodeRunner } from './amp.js';
import { AntigravityRunner } from './antigravity.js';
import type { Runner } from './types.js';
// 러너 타입 집합의 단일 진실 소스(SSOT). `import type`이므로 컴파일 시 완전히 제거되어
// daemon 런타임/배포 산출물(dist)에는 이 패키지 의존이 남지 않는다(zero-dependency 유지).
import type { RunnerType } from '@agentteams/core-constants';

export const createRunnerFactory = (runnerCmd: string) => {
  return (runnerType: string): Runner => {
    // SSOT(RunnerType)와의 exhaustive 일치를 컴파일 타임에 강제한다.
    // - SSOT에 값이 추가되면 default의 `never` 대입에서 타입 에러가 난다(누락 case 감지).
    // - SSOT에 없는 case를 추가하면 case 레이블이 RunnerType에 assignable하지 않아 타입 에러가 난다.
    const type = runnerType as RunnerType;
    switch (type) {
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
      default: {
        const _exhaustive: never = type;
        throw new Error(`Unsupported runner type: ${runnerType || _exhaustive}`);
      }
    }
  };
};
