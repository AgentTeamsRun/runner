import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupInstalledWindowsLaunchers, installWindowsLauncher } from './windows-launcher.js';

const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

test('installWindowsLauncher validates and installs a content-addressed immutable launcher', async () => {
  const binary = Buffer.from('native launcher');
  const packageRoot = join('test-root', 'pkg');
  const files = new Map<string, Buffer>();
  files.set(join(packageRoot, 'package.json'), Buffer.from(JSON.stringify({ version: '1.2.3' })));
  files.set(
    join(packageRoot, 'native', 'bin', 'win32-x64', 'manifest.json'),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fileName: 'agentrunner-launcher.exe',
        sha256: hash(binary),
      }),
    ),
  );
  files.set(join(packageRoot, 'native', 'bin', 'win32-x64', 'agentrunner-launcher.exe'), binary);
  const copied: string[] = [];

  const result = await installWindowsLauncher({
    packageRoot,
    homeDir: join('test-root', 'home'),
    platform: 'win32',
    arch: 'x64',
    release: '10.0.26100',
    readFile: (async (path: string) => {
      const value = files.get(path);
      if (!value) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    }) as typeof import('node:fs').promises.readFile,
    mkdir: async () => undefined,
    copyFile: async (source, destination) => {
      copied.push(String(destination));
      files.set(String(destination), files.get(String(source))!);
    },
    rename: async (source, destination) => {
      files.set(String(destination), files.get(String(source))!);
      files.delete(String(source));
    },
  });

  assert.match(result, /agentrunner-launcher-1\.2\.3-[a-f0-9]{12}\.exe$/u);
  assert.equal(copied.length, 1);
});

test('installWindowsLauncher prunes superseded launchers and interrupted temp files', async () => {
  const binary = Buffer.from('native launcher');
  const packageRoot = join('test-root', 'pkg');
  const homeDir = join('test-root', 'home');
  const installDir = join(homeDir, '.agentteams', 'bin');
  const digest = hash(binary);
  const targetFileName = `agentrunner-launcher-1.2.3-${digest.slice(0, 12)}.exe`;
  const files = new Map<string, Buffer>();
  files.set(join(packageRoot, 'package.json'), Buffer.from(JSON.stringify({ version: '1.2.3' })));
  files.set(
    join(packageRoot, 'native', 'bin', 'win32-x64', 'manifest.json'),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fileName: 'agentrunner-launcher.exe',
        sha256: digest,
      }),
    ),
  );
  files.set(join(packageRoot, 'native', 'bin', 'win32-x64', 'agentrunner-launcher.exe'), binary);
  // The target already exists and verifies, so this exercises the early return —
  // the path an unchanged runner takes on every single restart.
  files.set(join(installDir, targetFileName), binary);
  const unlinked: string[] = [];

  const result = await installWindowsLauncher({
    packageRoot,
    homeDir,
    platform: 'win32',
    arch: 'x64',
    release: '10.0.26100',
    readFile: (async (path: string) => {
      const value = files.get(path);
      if (!value) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    }) as typeof import('node:fs').promises.readFile,
    mkdir: async () => undefined,
    readdir: (async () => [
      targetFileName,
      'agentrunner-launcher-1.2.2-0123456789ab.exe',
      `${targetFileName}.4242.tmp`,
      'daemon.json',
    ]) as unknown as typeof import('node:fs').promises.readdir,
    unlink: (async (path: string) => {
      unlinked.push(String(path));
    }) as typeof import('node:fs').promises.unlink,
  });

  assert.equal(result, join(installDir, targetFileName));
  assert.deepEqual(
    unlinked.sort(),
    [
      join(installDir, `${targetFileName}.4242.tmp`),
      join(installDir, 'agentrunner-launcher-1.2.2-0123456789ab.exe'),
    ].sort(),
  );
});

test('cleanupInstalledWindowsLaunchers removes every launcher and temp file but leaves unrelated files', async () => {
  const homeDir = join('test-root', 'home');
  const installDir = join(homeDir, '.agentteams', 'bin');
  const unlinked: string[] = [];

  await cleanupInstalledWindowsLaunchers({
    homeDir,
    readdir: (async () => [
      'agentrunner-launcher-1.2.3-0123456789ab.exe',
      'agentrunner-launcher-1.2.3-0123456789ab.exe.777.tmp',
      'daemon.json',
      'agentrunner.log',
    ]) as unknown as typeof import('node:fs').promises.readdir,
    unlink: (async (path: string) => {
      unlinked.push(String(path));
    }) as typeof import('node:fs').promises.unlink,
  });

  assert.deepEqual(unlinked.sort(), [
    join(installDir, 'agentrunner-launcher-1.2.3-0123456789ab.exe'),
    join(installDir, 'agentrunner-launcher-1.2.3-0123456789ab.exe.777.tmp'),
  ]);
});

test('installWindowsLauncher fails closed on hash mismatch and unsupported architecture', async () => {
  const readFile = (async (path: string) => {
    if (path.endsWith('package.json')) return Buffer.from(JSON.stringify({ version: '1.2.3' }));
    if (path.endsWith('manifest.json')) {
      return Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          version: '1.2.3',
          platform: 'win32',
          arch: 'x64',
          fileName: 'agentrunner-launcher.exe',
          sha256: '0'.repeat(64),
        }),
      );
    }
    return Buffer.from('tampered');
  }) as typeof import('node:fs').promises.readFile;

  await assert.rejects(
    installWindowsLauncher({ packageRoot: 'C:\\pkg', platform: 'win32', arch: 'x64', readFile }),
    /SHA-256/u,
  );
  await assert.rejects(
    installWindowsLauncher({
      packageRoot: 'C:\\pkg',
      platform: 'win32',
      arch: 'arm64',
      release: '10.0.19045',
      readFile,
    }),
    /Unsupported Windows architecture/u,
  );
});
