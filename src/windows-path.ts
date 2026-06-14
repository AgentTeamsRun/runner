import { execFileSync } from 'node:child_process';
import { platform as getPlatform } from 'node:os';

/**
 * On Windows the daemon is launched from a Startup-folder VBS that bakes in a
 * frozen PATH snapshot captured at autostart-registration time (see autostart.ts).
 * Any directory added to the user/machine PATH afterwards — which is how every
 * CLI installer (npm, scoop, choco, native installers) exposes its binary — is
 * invisible to that snapshot, so the daemon fails to resolve runner executables
 * even though a fresh shell finds them.
 *
 * To stay install-method agnostic we read the live User + Machine PATH from the
 * registry at startup and merge any missing directories into process.env.PATH.
 * The merge is additive: existing entries (e.g. nvm paths from the snapshot) are
 * preserved and only previously-absent directories are appended.
 */

type RegistryPathSource = {
  root: string;
};

type RefreshDeps = {
  platform?: typeof getPlatform;
  execFileSync?: typeof execFileSync;
  env?: NodeJS.ProcessEnv;
};

const USER_PATH_SOURCE: RegistryPathSource = { root: 'HKCU\\Environment' };
const MACHINE_PATH_SOURCE: RegistryPathSource = {
  root: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
};

// Matches a `reg query ... /v Path` value line, e.g.
//   "    Path    REG_EXPAND_SZ    C:\\foo;%LOCALAPPDATA%\\bar"
// The data segment (group 1) may itself contain spaces, so we capture everything
// after the value type to the end of the line.
const REGISTRY_PATH_VALUE_PATTERN = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/iu;

const parseRegistryPathValue = (output: string): string | null => {
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(REGISTRY_PATH_VALUE_PATTERN);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
};

const lookupEnvCaseInsensitive = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const directHit = env[name];
  if (directHit !== undefined) {
    return directHit;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }

  return undefined;
};

// Registry PATH values use REG_EXPAND_SZ placeholders such as %SystemRoot% or
// %LOCALAPPDATA%. Expand them from the current environment; leave unknown
// placeholders untouched so a missing variable never collapses a directory.
export const expandWindowsEnvPlaceholders = (value: string, env: NodeJS.ProcessEnv): string =>
  value.replace(/%([^%]+)%/gu, (whole, name: string) => lookupEnvCaseInsensitive(env, name) ?? whole);

const toPathKey = (entry: string): string => entry.replace(/[\\/]+$/u, '').toLowerCase();

export const mergePathEntries = (existingPath: string, additionalPaths: string[]): string => {
  const existingEntries = existingPath.split(';').filter((entry) => entry.length > 0);
  const seen = new Set(existingEntries.map(toPathKey));
  const merged = [...existingEntries];

  for (const additional of additionalPaths) {
    const entry = additional.trim();
    if (entry.length === 0) {
      continue;
    }

    const key = toPathKey(entry);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(entry);
  }

  return merged.join(';');
};

const readRegistryPath = (
  source: RegistryPathSource,
  runner: typeof execFileSync,
  env: NodeJS.ProcessEnv,
): string[] => {
  let output: string;
  try {
    output = String(
      runner('reg', ['query', source.root, '/v', 'Path'], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  } catch {
    return [];
  }

  const rawValue = parseRegistryPathValue(output);
  if (!rawValue) {
    return [];
  }

  return expandWindowsEnvPlaceholders(rawValue, env)
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

/**
 * Merge the live registry User + Machine PATH into process.env.PATH on Windows.
 * No-op on other platforms. Returns the directories that were newly added so the
 * caller can log what the stale snapshot was missing.
 */
export const refreshWindowsPathFromRegistry = (deps: RefreshDeps = {}): string[] => {
  const os = (deps.platform ?? getPlatform)();
  if (os !== 'win32') {
    return [];
  }

  const runner = deps.execFileSync ?? execFileSync;
  const env = deps.env ?? process.env;
  const currentPath = env.PATH ?? '';

  // Machine PATH precedes User PATH to mirror how Windows composes the effective
  // PATH; both are appended after the existing process PATH so nothing breaks.
  const registryEntries = [
    ...readRegistryPath(MACHINE_PATH_SOURCE, runner, env),
    ...readRegistryPath(USER_PATH_SOURCE, runner, env),
  ];

  const mergedPath = mergePathEntries(currentPath, registryEntries);
  const beforeKeys = new Set(
    currentPath
      .split(';')
      .filter((entry) => entry.length > 0)
      .map(toPathKey),
  );
  const addedEntries = mergedPath.split(';').filter((entry) => entry.length > 0 && !beforeKeys.has(toPathKey(entry)));

  env.PATH = mergedPath;

  return addedEntries;
};
