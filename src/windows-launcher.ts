import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, platform, arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WindowsLauncherManifest = {
  schemaVersion: 1;
  version: string;
  platform: 'win32';
  arch: 'x64';
  fileName: 'agentrunner-launcher.exe';
  sha256: string;
};

type WindowsLauncherDeps = {
  packageRoot?: string;
  homeDir?: string;
  platform?: string;
  arch?: string;
  release?: string;
  readFile?: typeof fs.readFile;
  mkdir?: typeof fs.mkdir;
  copyFile?: typeof fs.copyFile;
  rename?: typeof fs.rename;
  unlink?: typeof fs.unlink;
  readdir?: typeof fs.readdir;
};

// Matches both installed launchers and the `<target>.<pid>.tmp` staging files an
// interrupted install can leave behind.
const INSTALLED_LAUNCHER_PATTERN = /^agentrunner-launcher-.+\.exe(\.\d+\.tmp)?$/u;

// `keepFileName` is the launcher the caller just verified; every other copy is a
// superseded version. Uninstall passes nothing so the directory is emptied.
export const cleanupInstalledWindowsLaunchers = async (
  deps: WindowsLauncherDeps & { keepFileName?: string } = {},
): Promise<void> => {
  const installDir = join(deps.homeDir ?? homedir(), '.agentteams', 'bin');
  let entries: string[];
  try {
    entries = await (deps.readdir ?? fs.readdir)(installDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => INSTALLED_LAUNCHER_PATTERN.test(entry) && entry !== deps.keepFileName)
      .map(async (entry) => {
        try {
          await (deps.unlink ?? fs.unlink)(join(installDir, entry));
        } catch {
          // A launcher still referenced by a live process remains for the next cleanup.
        }
      }),
  );
};

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

const assertSupportedWindows = (os: string, cpu: string, osRelease: string): void => {
  if (os !== 'win32') {
    throw new Error('The native AgentRunner launcher can only be installed on Windows.');
  }
  if (cpu === 'x64') {
    return;
  }
  const windowsBuild = Number.parseInt(osRelease.split('.')[2] ?? '0', 10);
  if (cpu === 'arm64' && windowsBuild >= 22_000) {
    return;
  }
  throw new Error(
    `Unsupported Windows architecture '${cpu}' (${osRelease}). ` +
      'Use Windows x64 or Windows 11 ARM64 with x64 emulation.',
  );
};

const parseManifest = (raw: string, packageVersion: string): WindowsLauncherManifest => {
  const value = JSON.parse(raw) as Partial<WindowsLauncherManifest>;
  if (
    value.schemaVersion !== 1 ||
    value.platform !== 'win32' ||
    value.arch !== 'x64' ||
    value.fileName !== 'agentrunner-launcher.exe' ||
    value.version !== packageVersion ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')
  ) {
    throw new Error('The packaged Windows launcher manifest is invalid or does not match the Runner version.');
  }
  return value as WindowsLauncherManifest;
};

export const installWindowsLauncher = async (deps: WindowsLauncherDeps = {}): Promise<string> => {
  assertSupportedWindows(deps.platform ?? platform(), deps.arch ?? arch(), deps.release ?? release());
  const readFile = deps.readFile ?? fs.readFile;
  const packageRoot = deps.packageRoot ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const nativeDir = join(packageRoot, 'native', 'bin', 'win32-x64');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version?: string };
  if (!packageJson.version) {
    throw new Error('Cannot determine the installed AgentRunner package version.');
  }
  const manifest = parseManifest(await readFile(join(nativeDir, 'manifest.json'), 'utf8'), packageJson.version);
  const sourcePath = join(nativeDir, manifest.fileName);
  const sourceBytes = await readFile(sourcePath);
  if (sha256(sourceBytes) !== manifest.sha256) {
    throw new Error('The packaged Windows launcher failed SHA-256 verification. Reinstall @agentteams/runner.');
  }

  const installDir = join(deps.homeDir ?? homedir(), '.agentteams', 'bin');
  const targetFileName = `agentrunner-launcher-${manifest.version}-${manifest.sha256.slice(0, 12)}.exe`;
  const targetPath = join(installDir, targetFileName);
  // Every upgrade installs under a new content-addressed name, so prune the
  // superseded copies here — uninstall is far too late to be the only sweep.
  const pruneSupersededLaunchers = async (): Promise<void> => {
    await cleanupInstalledWindowsLaunchers({ ...deps, keepFileName: targetFileName });
  };
  await (deps.mkdir ?? fs.mkdir)(installDir, { recursive: true });
  try {
    const existingBytes = await readFile(targetPath);
    if (sha256(existingBytes) === manifest.sha256) {
      await pruneSupersededLaunchers();
      return targetPath;
    }
    throw new Error(`Existing immutable launcher has unexpected contents: ${targetPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await (deps.copyFile ?? fs.copyFile)(sourcePath, temporaryPath);
  const copiedBytes = await readFile(temporaryPath);
  if (sha256(copiedBytes) !== manifest.sha256) {
    await (deps.unlink ?? fs.unlink)(temporaryPath).catch(() => undefined);
    throw new Error('The installed Windows launcher failed SHA-256 verification.');
  }
  try {
    await (deps.rename ?? fs.rename)(temporaryPath, targetPath);
  } catch (error) {
    await (deps.unlink ?? fs.unlink)(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await pruneSupersededLaunchers();
  return targetPath;
};
