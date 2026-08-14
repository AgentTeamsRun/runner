import type { RunnerType } from '@agentteams/core-constants';
import { getKimiExecutablePreference } from './kimi-cli.js';
import { getKiroExecutablePreference } from './kiro-cli.js';

export type EngineCommand = string | ((runnerCmd: string) => string);

/// 실행 파일 해석 선호 목록. 러너 모듈이 기동 시 넘기는 것과 같은 목록이어야
/// 탐지 결과와 실제 기동 가능 여부가 갈리지 않는다(특히 Windows의 .cmd/.exe).
export type EnginePreference = (command: string, isWindows: boolean) => string[];

/// 대부분의 엔진은 Windows에서 npm 셸 shim(.cmd)을 먼저 본다.
const npmShimPreference: EnginePreference = (command, isWindows) =>
  isWindows ? [`${command}.cmd`, command] : [command];

type EngineDefinition = {
  command: EngineCommand;
  preference: EnginePreference;
};

// RunnerType 추가 시 설치 탐지 대상도 반드시 함께 정의되도록 exhaustive Record로 유지한다.
export const ENGINE_COMMANDS: Record<RunnerType, EngineDefinition> = {
  OPENCODE: { command: (runnerCmd) => runnerCmd, preference: npmShimPreference },
  CLAUDE_CODE: { command: 'claude', preference: npmShimPreference },
  CODEX: { command: 'codex', preference: npmShimPreference },
  ANTIGRAVITY: { command: 'agy', preference: npmShimPreference },
  AMP: { command: 'amp', preference: npmShimPreference },
  COPILOT_CLI: { command: 'copilot', preference: npmShimPreference },
  // Cursor는 러너도 선호 목록 없이 이름만으로 해석한다.
  CURSOR_CLI: { command: 'agent', preference: (command) => [command] },
  KIMI_CLI: { command: 'kimi', preference: (_command, isWindows) => getKimiExecutablePreference(isWindows) },
  KIRO_CLI: { command: 'kiro-cli', preference: (_command, isWindows) => getKiroExecutablePreference(isWindows) },
};

export const getEngineCommand = (runnerType: RunnerType, runnerCmd: string): string => {
  const { command } = ENGINE_COMMANDS[runnerType];
  return typeof command === 'function' ? command(runnerCmd) : command;
};

export const getEngineExecutablePreference = (
  runnerType: RunnerType,
  runnerCmd: string,
  isWindows: boolean,
): string[] => ENGINE_COMMANDS[runnerType].preference(getEngineCommand(runnerType, runnerCmd), isWindows);
