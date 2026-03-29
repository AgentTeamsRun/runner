import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { platform as getPlatform } from "node:os";
import { join } from "node:path";

const DEFAULT_WINDOWS_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

type ExecutableDeps = {
  env?: NodeJS.ProcessEnv;
  execFileSync?: typeof execFileSync;
  existsSync?: typeof existsSync;
  platform?: typeof getPlatform;
};

type SpawnExecutableOptions = SpawnOptions & ExecutableDeps;
type RunExecutableSyncOptions = ExecutableDeps & {
  cwd?: string;
};

const getFirstOutputLine = (output: string): string | null => {
  const firstLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? null;
};

const getWindowsExecutableNames = (name: string, env: NodeJS.ProcessEnv): string[] => {
  if (/\.[^./\\]+$/u.test(name)) {
    return [name];
  }

  const pathExt = env.PATHEXT
    ?.split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const extensions = pathExt && pathExt.length > 0 ? pathExt : DEFAULT_WINDOWS_EXTENSIONS;

  return [name, ...extensions.map((extension) => `${name}${extension}`)];
};

const getNpmGlobalBinPath = (deps: ExecutableDeps): string | null => {
  const run = deps.execFileSync ?? execFileSync;

  try {
    const output = run("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
};

const resolveFromPathLookup = (name: string, deps: ExecutableDeps): string | null => {
  const os = (deps.platform ?? getPlatform)();
  const run = deps.execFileSync ?? execFileSync;
  const lookupCommand = os === "win32" ? "where" : "which";

  try {
    const output = run(lookupCommand, [name], { encoding: "utf8", windowsHide: true });
    return getFirstOutputLine(output);
  } catch {
    return null;
  }
};

const resolveFromNpmGlobalBin = (name: string, deps: ExecutableDeps): string | null => {
  const os = (deps.platform ?? getPlatform)();
  const fileExists = deps.existsSync ?? existsSync;
  const npmGlobalBinPath = getNpmGlobalBinPath(deps);

  if (!npmGlobalBinPath) {
    return null;
  }

  const candidateNames =
    os === "win32" ? getWindowsExecutableNames(name, deps.env ?? process.env) : [name];

  for (const candidateName of candidateNames) {
    const candidatePath = join(npmGlobalBinPath, candidateName);
    if (fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
};

const escapeForPowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const buildPowerShellCommand = (executablePath: string, args: string[]): string => {
  const serializedArgs = [escapeForPowerShell(executablePath), ...args.map(escapeForPowerShell)];
  return `& ${serializedArgs.join(" ")}`;
};

export const resolveExecutablePath = (name: string, deps: ExecutableDeps = {}): string => {
  const os = (deps.platform ?? getPlatform)();

  const resolvedPath = resolveFromPathLookup(name, deps) ?? resolveFromNpmGlobalBin(name, deps);
  if (resolvedPath) {
    return resolvedPath;
  }

  const checkedLocations = os === "win32" ? "PATH and npm global bin" : "PATH";
  throw new Error(
    `Cannot find '${name}' executable. Checked ${checkedLocations}. Ensure it is installed and available globally.`
  );
};

export const resolveExecutablePathWithPreference = (
  name: string,
  preferredNames: string[],
  deps: ExecutableDeps = {}
): string => {
  for (const preferredName of preferredNames) {
    const resolvedPath = resolveFromPathLookup(preferredName, deps) ?? resolveFromNpmGlobalBin(preferredName, deps);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return resolveExecutablePath(name, deps);
};

export const describeExecutableResolution = (
  name: string,
  deps: ExecutableDeps = {}
): {
  requestedCommand: string;
  resolvedExecutablePath: string;
  platform: string;
  shell: boolean;
} => {
  const os = (deps.platform ?? getPlatform)();

  return {
    requestedCommand: name,
    resolvedExecutablePath: resolveExecutablePath(name, deps),
    platform: os,
    shell: false
  };
};

export const spawnExecutable = (
  name: string,
  args: string[],
  options: SpawnExecutableOptions
): ChildProcess => {
  const os = (options.platform ?? getPlatform)();
  const executablePath = resolveExecutablePath(name, options);

  if (os === "win32") {
    return spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildPowerShellCommand(executablePath, args)
      ],
      {
        ...options,
        shell: false,
        windowsHide: options.windowsHide ?? true
      }
    );
  }

  return spawn(executablePath, args, {
    ...options,
    shell: false
  });
};

export const runExecutableSync = (
  name: string,
  args: string[],
  options: RunExecutableSyncOptions = {}
): string => {
  const os = (options.platform ?? getPlatform)();
  const run = options.execFileSync ?? execFileSync;
  const executablePath = resolveExecutablePath(name, options);

  if (os === "win32") {
    return String(run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildPowerShellCommand(executablePath, args)
      ],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        windowsHide: true
      }
    ));
  }

  return String(run(executablePath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8"
  }));
};
