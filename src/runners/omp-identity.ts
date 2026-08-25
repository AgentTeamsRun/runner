import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand, type AsyncExecutableDeps } from '../executable.js';

/**
 * `--help` 첫머리와 ACP 서브커맨드 설명에 실측된 고유 문구(2026-08-24, omp/18.0.4).
 * npm의 무관한 `omp@1.0.0`(2019)에는 이 문자열이 없다.
 */
export const OMP_IDENTITY_MARKER = 'Oh My Pi';

export type OmpIdentityDependencies = AsyncExecutableDeps & {
  resolveExecutablePathsWithPreferenceAsync?: typeof resolveExecutablePathsWithPreferenceAsync;
  runProbeCommand?: typeof runProbeCommand;
};

export const isOmpExecutable = async (executablePath: string, deps: OmpIdentityDependencies = {}): Promise<boolean> => {
  const run = deps.runProbeCommand ?? runProbeCommand;
  const output = await run(executablePath, ['--help'], deps);
  return output !== null && output.includes(OMP_IDENTITY_MARKER);
};

export const findOmpExecutable = async (
  preferredNames: string[],
  deps: OmpIdentityDependencies = {},
): Promise<string | null> => {
  const resolveAll = deps.resolveExecutablePathsWithPreferenceAsync ?? resolveExecutablePathsWithPreferenceAsync;
  const candidates = await resolveAll('omp', preferredNames, deps);

  for (const candidate of candidates) {
    if (await isOmpExecutable(candidate, deps)) return candidate;
  }

  return null;
};
