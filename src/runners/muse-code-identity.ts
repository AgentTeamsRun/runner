import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand, type AsyncExecutableDeps } from '../executable.js';

// muse 1.0.2 (2026-09-04) help의 고유 문구. 동명 npm CMS 도구를 제외한다.
export const MUSE_CODE_IDENTITY_MARKER = 'muse — interactive terminal coding agent';

export type MuseCodeIdentityDependencies = AsyncExecutableDeps & {
  resolveExecutablePathsWithPreferenceAsync?: typeof resolveExecutablePathsWithPreferenceAsync;
  runProbeCommand?: typeof runProbeCommand;
};

export const isMuseCodeExecutable = async (
  executablePath: string,
  deps: MuseCodeIdentityDependencies = {},
): Promise<boolean> => {
  const run = deps.runProbeCommand ?? runProbeCommand;
  const output = await run(executablePath, ['--help'], deps);
  return output !== null && output.includes(MUSE_CODE_IDENTITY_MARKER);
};

export const findMuseCodeExecutable = async (
  preferredNames: string[],
  deps: MuseCodeIdentityDependencies = {},
): Promise<string | null> => {
  const resolveAll = deps.resolveExecutablePathsWithPreferenceAsync ?? resolveExecutablePathsWithPreferenceAsync;
  const candidates = await resolveAll('muse', preferredNames, deps);

  for (const candidate of candidates) {
    if (await isMuseCodeExecutable(candidate, deps)) return candidate;
  }

  return null;
};
