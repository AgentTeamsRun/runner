import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform as getPlatform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const DEFAULT_WINDOWS_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

export type ExecutableDeps = {
  env?: NodeJS.ProcessEnv;
  execFileSync?: typeof execFileSync;
  existsSync?: typeof existsSync;
  npmGlobalBinPath?: string | null;
  platform?: typeof getPlatform;
};

type SpawnExecutableOptions = SpawnOptions & ExecutableDeps;
type RunExecutableSyncOptions = ExecutableDeps & {
  cwd?: string;
};

type KnownInstallBinResolver = (env: NodeJS.ProcessEnv, os: NodeJS.Platform) => string[];

const resolveUserLocalBin: KnownInstallBinResolver = (env, os) => {
  if (os === 'win32' || !env.HOME) {
    return [];
  }

  return [join(env.HOME, '.local', 'bin')];
};

const getOutputLines = (output: string): string[] =>
  output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const getFirstOutputLine = (output: string): string | null => {
  const firstLine = getOutputLines(output)[0];

  return firstLine ?? null;
};

const getWindowsCommandBaseName = (name: string): string => name.replace(/\.(?:cmd|exe|bat|com)$/iu, '').toLowerCase();

const getWindowsPathFileName = (path: string): string => {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1]?.toLowerCase() ?? '';
};

// Extensions the PowerShell `&` launcher (and CreateProcess) can actually run.
const WINDOWS_RUNNABLE_EXTENSION = /\.(?:cmd|exe|bat|com|ps1)$/iu;

const selectPathLookupResult = (name: string, output: string, os: NodeJS.Platform): string | null => {
  if (os !== 'win32') {
    return getFirstOutputLine(output);
  }

  const lines = getOutputLines(output);
  const commandBaseName = getWindowsCommandBaseName(name);

  if (commandBaseName === 'npm' || commandBaseName === 'npx') {
    const cmdShim = lines.find((line) => getWindowsPathFileName(line) === `${commandBaseName}.cmd`);
    if (cmdShim) {
      return cmdShim;
    }
  }

  // `where` lists the extensionless POSIX shim (a `#!/bin/sh` file that npm
  // installs next to the .cmd/.exe) first, but the PowerShell `&` launcher used
  // to spawn runners cannot execute it — it exits 0 without running node. Prefer
  // a Windows-runnable extension whenever one is present.
  const runnableExecutable = lines.find((line) => WINDOWS_RUNNABLE_EXTENSION.test(line));
  if (runnableExecutable) {
    return runnableExecutable;
  }

  return lines[0] ?? null;
};

const getWindowsExecutableNames = (name: string, env: NodeJS.ProcessEnv): string[] => {
  if (/\.[^./\\]+$/u.test(name)) {
    return [name];
  }

  const pathExt = env.PATHEXT?.split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const extensions = pathExt && pathExt.length > 0 ? pathExt : DEFAULT_WINDOWS_EXTENSIONS;

  return [name, ...extensions.map((extension) => `${name}${extension}`)];
};

export const getNpmGlobalBinPath = (deps: ExecutableDeps = {}): string | null => {
  const run = deps.execFileSync ?? execFileSync;

  try {
    const output = run('npm', ['prefix', '-g'], { encoding: 'utf8', windowsHide: true }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
};

const resolveFromPathLookup = (name: string, deps: ExecutableDeps): string | null => {
  const os = (deps.platform ?? getPlatform)();
  const run = deps.execFileSync ?? execFileSync;
  const lookupCommand = os === 'win32' ? 'where' : 'which';

  try {
    const output = run(lookupCommand, [name], { encoding: 'utf8', windowsHide: true });
    return selectPathLookupResult(name, output, os);
  } catch {
    return null;
  }
};

const resolveFromNpmGlobalBin = (name: string, deps: ExecutableDeps): string | null => {
  const os = (deps.platform ?? getPlatform)();
  const fileExists = deps.existsSync ?? existsSync;
  const npmGlobalBinPath = deps.npmGlobalBinPath !== undefined ? deps.npmGlobalBinPath : getNpmGlobalBinPath(deps);

  if (!npmGlobalBinPath) {
    return null;
  }

  const candidateNames = os === 'win32' ? getWindowsExecutableNames(name, deps.env ?? process.env) : [name];

  for (const candidateName of candidateNames) {
    const candidatePath = join(npmGlobalBinPath, candidateName);
    if (fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
};

const knownInstallBinResolvers: Readonly<Record<string, KnownInstallBinResolver>> = {
  agy: (env, os) => (os === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'agy', 'bin')] : []),
  // Claude Code와 Codex의 공식 standalone 설치는 macOS/Linux에서 ~/.local/bin에
  // 실행 파일 링크를 만든다. 비대화형 러너는 셸 프로필의 PATH 보강을 읽지 않으므로
  // 설치가 정상이어도 이 사용자 로컬 경로를 놓칠 수 있다.
  claude: resolveUserLocalBin,
  codex: resolveUserLocalBin,
  kimi: (env, os) => {
    const configuredHomePaths = env.KIMI_CODE_HOME ? [join(env.KIMI_CODE_HOME, 'bin')] : [];
    const userHome = os === 'win32' ? env.USERPROFILE : env.HOME;
    const defaultHomePaths = userHome ? [join(userHome, '.kimi-code', 'bin')] : [];

    return [...new Set([...configuredHomePaths, ...defaultHomePaths])];
  },
  // Kiro CLI는 셸 rc를 수정해 PATH를 넓히는 방식으로 설치되지만, 러너는 비대화형
  // 프로세스라 rc를 읽지 않는다(Kimi에서 동일 구조로 "Cannot find executable"이 났던 선례).
  // 아래 경로는 macOS에서 실측한 설치 위치다(2026-08-08, kiro-cli 2.16.2):
  //   ~/.local/bin/kiro-cli -> /Applications/Kiro CLI.app/Contents/MacOS/kiro-cli
  // Windows 설치 경로는 실측하지 못했고 공식 문서도 명시하지 않으므로, Windows에서는
  // 알려진 폴백 없이 PATH 탐색에만 의존한다.
  'kiro-cli': (env, os) => {
    if (os === 'win32') {
      return [];
    }

    const userHome = env.HOME;
    if (!userHome) {
      return [];
    }

    const localBin = join(userHome, '.local', 'bin');
    // 심볼릭 링크가 없을 때를 대비한 darwin 전용 2차 폴백(앱 번들 내부 실체 경로).
    const macAppBundleBin = os === 'darwin' ? [join('/Applications', 'Kiro CLI.app', 'Contents', 'MacOS')] : [];

    return [...new Set([localBin, ...macAppBundleBin])];
  },
};

const getKnownInstallBinPaths = (name: string, deps: ExecutableDeps): string[] => {
  const env = deps.env ?? process.env;
  const os = (deps.platform ?? getPlatform)();
  const normalizedName = getWindowsCommandBaseName(name);
  const resolveBinPaths = knownInstallBinResolvers[normalizedName];

  return resolveBinPaths?.(env, os) ?? [];
};

const resolveFromKnownInstallBin = (name: string, deps: ExecutableDeps): string | null => {
  const os = (deps.platform ?? getPlatform)();
  const fileExists = deps.existsSync ?? existsSync;
  const candidateNames = os === 'win32' ? getWindowsExecutableNames(name, deps.env ?? process.env) : [name];

  for (const binPath of getKnownInstallBinPaths(name, deps)) {
    for (const candidateName of candidateNames) {
      const candidatePath = join(binPath, candidateName);
      if (fileExists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
};

const escapeForPowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const buildPowerShellCommand = (executablePath: string, args: string[]): string => {
  const serializedArgs = [escapeForPowerShell(executablePath), ...args.map(escapeForPowerShell)];
  return `& ${serializedArgs.join(' ')}`;
};

export const resolveExecutablePath = (name: string, deps: ExecutableDeps = {}): string => {
  const resolvedPath =
    resolveFromPathLookup(name, deps) ?? resolveFromNpmGlobalBin(name, deps) ?? resolveFromKnownInstallBin(name, deps);
  if (resolvedPath) {
    return resolvedPath;
  }

  const checkedLocations =
    getKnownInstallBinPaths(name, deps).length > 0
      ? 'PATH, npm global bin, and known app install paths'
      : 'PATH and npm global bin';
  throw new Error(
    `Cannot find '${name}' executable. Checked ${checkedLocations}. Ensure it is installed and available globally.`,
  );
};

const execFileAsync = promisify(execFile);

export type AsyncExecutableDeps = ExecutableDeps & {
  execFileAsync?: typeof execFileAsync;
};

/// 설치 탐지용 하위 프로세스 호출 상한. 응답하지 않는 바이너리가 러너를 붙잡지 못하게 한다.
export const EXECUTABLE_PROBE_TIMEOUT_MS = 5_000;

const probeExecOptions = {
  encoding: 'utf8',
  windowsHide: true,
  timeout: EXECUTABLE_PROBE_TIMEOUT_MS,
  killSignal: 'SIGKILL',
  // 대화형 바이너리가 stdin을 기다리며 매달리지 않도록 입력을 닫는다.
  stdio: ['ignore', 'pipe', 'ignore'],
} as const;

const resolveFromPathLookupAsync = async (name: string, deps: AsyncExecutableDeps): Promise<string | null> => {
  const os = (deps.platform ?? getPlatform)();
  const run = deps.execFileAsync ?? execFileAsync;
  const lookupCommand = os === 'win32' ? 'where' : 'which';

  try {
    const { stdout } = await run(lookupCommand, [name], probeExecOptions);
    return selectPathLookupResult(name, String(stdout), os);
  } catch {
    return null;
  }
};

/// 이벤트 루프를 막지 않는 실행 파일 해석. 러너 기동과 같은 선호 목록·폴백 순서를 쓰되,
/// 탐지 용도이므로 실패는 예외 대신 null로 돌려준다.
export const resolveExecutablePathWithPreferenceAsync = async (
  name: string,
  preferredNames: string[],
  deps: AsyncExecutableDeps = {},
): Promise<string | null> => {
  for (const candidateName of new Set([...preferredNames, name])) {
    const resolvedPath =
      (await resolveFromPathLookupAsync(candidateName, deps)) ??
      resolveFromNpmGlobalBin(candidateName, deps) ??
      resolveFromKnownInstallBin(candidateName, deps);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
};

export const getNpmGlobalBinPathAsync = async (deps: AsyncExecutableDeps = {}): Promise<string | null> => {
  const run = deps.execFileAsync ?? execFileAsync;

  try {
    const { stdout } = await run('npm', ['prefix', '-g'], probeExecOptions);
    const output = String(stdout).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
};

/// PATH 조회 명령 자체를 실행할 수 있는지. 실행조차 못 하면(ENOENT) 탐지 결과 전체를 믿을 수 없다.
/// "찾지 못함"(exit 1)은 조회가 동작한 것이므로 사용 가능으로 본다.
export const isExecutableLookupAvailable = async (deps: AsyncExecutableDeps = {}): Promise<boolean> => {
  const os = (deps.platform ?? getPlatform)();
  const run = deps.execFileAsync ?? execFileAsync;
  const lookupCommand = os === 'win32' ? 'where' : 'which';

  try {
    await run(lookupCommand, [lookupCommand], probeExecOptions);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT';
  }
};

export const runProbeCommand = async (
  executablePath: string,
  args: string[],
  deps: AsyncExecutableDeps = {},
): Promise<string | null> => {
  const run = deps.execFileAsync ?? execFileAsync;

  try {
    const { stdout } = await run(executablePath, args, probeExecOptions);
    return String(stdout);
  } catch {
    return null;
  }
};

export const resolveExecutablePathWithPreference = (
  name: string,
  preferredNames: string[],
  deps: ExecutableDeps = {},
): string => {
  for (const preferredName of preferredNames) {
    const resolvedPath =
      resolveFromPathLookup(preferredName, deps) ??
      resolveFromNpmGlobalBin(preferredName, deps) ??
      resolveFromKnownInstallBin(preferredName, deps);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return resolveExecutablePath(name, deps);
};

export const describeExecutableResolution = (
  name: string,
  deps: ExecutableDeps = {},
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
    shell: false,
  };
};

export const spawnExecutable = (name: string, args: string[], options: SpawnExecutableOptions): ChildProcess => {
  const os = (options.platform ?? getPlatform)();
  const executablePath = resolveExecutablePath(name, options);

  if (os === 'win32') {
    return spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildPowerShellCommand(executablePath, args),
      ],
      {
        ...options,
        shell: false,
        windowsHide: options.windowsHide ?? true,
      },
    );
  }

  return spawn(executablePath, args, {
    ...options,
    shell: false,
  });
};

export const runExecutableSync = (name: string, args: string[], options: RunExecutableSyncOptions = {}): string => {
  const os = (options.platform ?? getPlatform)();
  const run = options.execFileSync ?? execFileSync;
  const executablePath = resolveExecutablePath(name, options);

  if (os === 'win32') {
    return String(
      run(
        'powershell.exe',
        [
          '-NoLogo',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          buildPowerShellCommand(executablePath, args),
        ],
        {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
          windowsHide: true,
        },
      ),
    );
  }

  return String(
    run(executablePath, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
    }),
  );
};
