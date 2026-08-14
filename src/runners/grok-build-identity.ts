import { resolveExecutablePathsWithPreferenceAsync, runProbeCommand, type AsyncExecutableDeps } from '../executable.js';

export const GROK_BUILD_IDENTITY_MARKER = 'Grok Build TUI';

export type GrokBuildIdentityDependencies = AsyncExecutableDeps & {
  resolveExecutablePathsWithPreferenceAsync?: typeof resolveExecutablePathsWithPreferenceAsync;
  runProbeCommand?: typeof runProbeCommand;
};

export const isGrokBuildExecutable = async (
  executablePath: string,
  deps: GrokBuildIdentityDependencies = {},
): Promise<boolean> => {
  const run = deps.runProbeCommand ?? runProbeCommand;
  const output = await run(executablePath, ['--help'], deps);
  return output !== null && output.includes(GROK_BUILD_IDENTITY_MARKER);
};

export const findGrokBuildExecutable = async (
  preferredNames: string[],
  deps: GrokBuildIdentityDependencies = {},
): Promise<string | null> => {
  const resolveAll = deps.resolveExecutablePathsWithPreferenceAsync ?? resolveExecutablePathsWithPreferenceAsync;
  const candidates = await resolveAll('grok', preferredNames, deps);

  for (const candidate of candidates) {
    if (await isGrokBuildExecutable(candidate, deps)) return candidate;
  }

  return null;
};
