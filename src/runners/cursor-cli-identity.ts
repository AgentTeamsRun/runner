import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand, type AsyncExecutableDeps } from '../executable.js';

// Cursor CLI help의 고유 문구. `agent`는 일반적인 이름이라 다른 도구(예: Grok Build 설치기가 만드는
// `~/.grok/bin/agent` 별칭)가 PATH 앞에 올 수 있으므로, 탐지와 기동 모두 이 문구로 신원을 확인한다.
export const CURSOR_CLI_IDENTITY_MARKER = 'Start the Cursor Agent';

export type CursorCliIdentityDependencies = AsyncExecutableDeps & {
  resolveExecutablePathsWithPreferenceAsync?: typeof resolveExecutablePathsWithPreferenceAsync;
  runProbeCommand?: typeof runProbeCommand;
};

export const isCursorCliExecutable = async (
  executablePath: string,
  deps: CursorCliIdentityDependencies = {},
): Promise<boolean> => {
  const run = deps.runProbeCommand ?? runProbeCommand;
  const output = await run(executablePath, ['--help'], deps);
  return output !== null && output.includes(CURSOR_CLI_IDENTITY_MARKER);
};

export const findCursorCliExecutable = async (
  preferredNames: string[],
  deps: CursorCliIdentityDependencies = {},
): Promise<string | null> => {
  const resolveAll = deps.resolveExecutablePathsWithPreferenceAsync ?? resolveExecutablePathsWithPreferenceAsync;
  const candidates = await resolveAll('agent', preferredNames, deps);

  for (const candidate of candidates) {
    if (await isCursorCliExecutable(candidate, deps)) return candidate;
  }

  return null;
};
