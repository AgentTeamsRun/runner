import type { RunnerType } from '@agentteams/core-constants';
import {
  getNpmGlobalPrefixAsync,
  isExecutableLookupAvailable,
  resolveExecutablePathWithPreferenceAsync,
  resolveExecutablePathsWithPreferenceAsync,
  runProbeCommand,
  type AsyncExecutableDeps,
} from '../executable.js';
import { ENGINE_COMMANDS, getEngineCommand, getEngineExecutablePreference } from '../runners/engine-commands.js';
import { findGrokBuildExecutable } from '../runners/grok-build-identity.js';
import { findOmpExecutable } from '../runners/omp-identity.js';

type EngineProbeDependencies = AsyncExecutableDeps & {
  getNpmGlobalPrefixAsync?: typeof getNpmGlobalPrefixAsync;
  resolveExecutablePathWithPreferenceAsync?: typeof resolveExecutablePathWithPreferenceAsync;
  resolveExecutablePathsWithPreferenceAsync?: typeof resolveExecutablePathsWithPreferenceAsync;
  isExecutableLookupAvailable?: typeof isExecutableLookupAvailable;
  runProbeCommand?: typeof runProbeCommand;
};

export type EngineProbeResult = {
  engines: RunnerType[];
  /// 탐지 결과를 신뢰할 수 있는지. false면 "설치된 엔진이 없다"가 아니라 "탐지에 실패했다"는 뜻이라
  /// 서버에 보고하면 안 된다(빈 목록은 서버에서 제한 없음으로 해석된다).
  reliable: boolean;
};

const isCursorAgent = async (
  executablePath: string,
  run: typeof runProbeCommand,
  deps: EngineProbeDependencies,
): Promise<boolean> => {
  const output = await run(executablePath, ['--help'], deps);
  return output !== null && output.includes('Start the Cursor Agent');
};

export const probeInstalledEngines = async (
  runnerCmd: string,
  deps: EngineProbeDependencies = {},
): Promise<EngineProbeResult> => {
  const resolve = deps.resolveExecutablePathWithPreferenceAsync ?? resolveExecutablePathWithPreferenceAsync;
  const resolveNpmGlobalPrefix = deps.getNpmGlobalPrefixAsync ?? getNpmGlobalPrefixAsync;
  const checkLookupAvailable = deps.isExecutableLookupAvailable ?? isExecutableLookupAvailable;
  const runCommand = deps.runProbeCommand ?? runProbeCommand;
  const isWindows = (deps.platform ?? (() => process.platform))() === 'win32';
  const executableDeps: AsyncExecutableDeps = {
    ...deps,
    // 미설치 엔진마다 `npm prefix -g`를 반복하지 않도록 프로브 사이클에서 한 번만 계산한다.
    npmGlobalPrefix: await resolveNpmGlobalPrefix(deps),
  };
  const engines: RunnerType[] = [];

  for (const runnerType of Object.keys(ENGINE_COMMANDS) as RunnerType[]) {
    if (runnerType === 'GROK_BUILD' || runnerType === 'OMP') {
      const preferredNames = getEngineExecutablePreference(runnerType, runnerCmd, isWindows);
      const identityDependencies =
        deps.resolveExecutablePathWithPreferenceAsync && !deps.resolveExecutablePathsWithPreferenceAsync
          ? {
              ...executableDeps,
              runProbeCommand: runCommand,
              resolveExecutablePathsWithPreferenceAsync: async (name: string, preference: string[]) => {
                const candidate = await resolve(name, preference, executableDeps);
                return candidate ? [candidate] : [];
              },
            }
          : { ...executableDeps, runProbeCommand: runCommand };
      const found =
        runnerType === 'GROK_BUILD'
          ? await findGrokBuildExecutable(preferredNames, identityDependencies)
          : await findOmpExecutable(preferredNames, identityDependencies);
      if (found) engines.push(runnerType);
      continue;
    }

    const executablePath = await resolve(
      getEngineCommand(runnerType, runnerCmd),
      getEngineExecutablePreference(runnerType, runnerCmd, isWindows),
      executableDeps,
    );
    if (!executablePath) {
      continue;
    }

    // `agent`는 일반적인 이름이므로 Cursor 고유 help 문구까지 확인해 오탐을 막는다.
    if (runnerType === 'CURSOR_CLI' && !(await isCursorAgent(executablePath, runCommand, deps))) {
      continue;
    }

    engines.push(runnerType);
  }

  // 하나라도 찾았으면 조회 자체는 동작한 것이다. 0개일 때만 조회 명령의 가용성을 따져
  // "설치 0개"와 "탐지 실패"를 구분한다.
  const reliable = engines.length > 0 || (await checkLookupAvailable(deps));

  return { engines, reliable };
};
