import assert from 'node:assert/strict';
import test from 'node:test';
import { expandWindowsEnvPlaceholders, mergePathEntries, refreshWindowsPathFromRegistry } from './windows-path.js';

test('expandWindowsEnvPlaceholders expands known vars case-insensitively and leaves unknown intact', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\rlaru\\AppData\\Local' } as NodeJS.ProcessEnv;
  const expanded = expandWindowsEnvPlaceholders('%localappdata%\\Programs\\OpenAI\\Codex\\bin;%UNSET%\\x', env);

  assert.equal(expanded, 'C:\\Users\\rlaru\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin;%UNSET%\\x');
});

test('mergePathEntries appends only missing dirs, dedup is case/trailing-slash insensitive', () => {
  const merged = mergePathEntries('C:\\nvm4w\\nodejs;C:\\Windows\\System32', [
    'C:\\nvm4w\\nodejs\\', // duplicate (trailing slash)
    'c:\\windows\\system32', // duplicate (case)
    'C:\\Users\\rlaru\\.local\\bin', // new
  ]);

  assert.equal(merged, 'C:\\nvm4w\\nodejs;C:\\Windows\\System32;C:\\Users\\rlaru\\.local\\bin');
});

test('refreshWindowsPathFromRegistry is a no-op on non-Windows platforms', () => {
  const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
  const added = refreshWindowsPathFromRegistry({
    platform: () => 'linux',
    env,
    execFileSync: (() => {
      throw new Error('reg should not be called off Windows');
    }) as unknown as typeof import('node:child_process').execFileSync,
  });

  assert.deepEqual(added, []);
  assert.equal(env.PATH, '/usr/bin');
});

test('refreshWindowsPathFromRegistry merges live registry PATH missing from the snapshot', () => {
  const env = {
    PATH: 'C:\\WINDOWS\\system32;C:\\nvm4w\\nodejs',
    LOCALAPPDATA: 'C:\\Users\\rlaru\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\rlaru',
  } as NodeJS.ProcessEnv;

  const added = refreshWindowsPathFromRegistry({
    platform: () => 'win32',
    env,
    execFileSync: ((command: string, args: readonly string[]) => {
      assert.equal(command, 'reg');
      const root = args[1];
      if (root === 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') {
        return [
          '',
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
          '    Path    REG_EXPAND_SZ    C:\\WINDOWS\\system32;C:\\WINDOWS',
          '',
        ].join('\r\n');
      }

      if (root === 'HKCU\\Environment') {
        return [
          '',
          'HKEY_CURRENT_USER\\Environment',
          '    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin',
          '',
        ].join('\r\n');
      }

      throw new Error(`unexpected registry root: ${root}`);
    }) as unknown as typeof import('node:child_process').execFileSync,
  });

  // Existing entries preserved; snapshot already had system32 + nodejs.
  // Machine adds C:\WINDOWS; user adds the two native CLI install dirs (expanded).
  assert.deepEqual(added, [
    'C:\\WINDOWS',
    'C:\\Users\\rlaru\\.local\\bin',
    'C:\\Users\\rlaru\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin',
  ]);
  assert.equal(
    env.PATH,
    'C:\\WINDOWS\\system32;C:\\nvm4w\\nodejs;C:\\WINDOWS;C:\\Users\\rlaru\\.local\\bin;C:\\Users\\rlaru\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin',
  );
});

test('refreshWindowsPathFromRegistry tolerates a missing registry value gracefully', () => {
  const env = { PATH: 'C:\\WINDOWS\\system32' } as NodeJS.ProcessEnv;
  const added = refreshWindowsPathFromRegistry({
    platform: () => 'win32',
    env,
    execFileSync: (() => {
      throw new Error('ERROR: The system was unable to find the specified registry key or value.');
    }) as unknown as typeof import('node:child_process').execFileSync,
  });

  assert.deepEqual(added, []);
  assert.equal(env.PATH, 'C:\\WINDOWS\\system32');
});
