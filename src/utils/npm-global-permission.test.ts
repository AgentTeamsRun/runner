import assert from 'node:assert/strict';
import test from 'node:test';
import { canWriteGlobalNpmRoot } from './npm-global-permission.js';

const enoent = (): never => {
  const error = new Error('ENOENT') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
};

const eacces = (): never => {
  const error = new Error('EACCES') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  throw error;
};

test('canWriteGlobalNpmRoot checks <prefix>/lib/node_modules on POSIX', () => {
  const checked: string[] = [];

  const result = canWriteGlobalNpmRoot({
    npmGlobalPrefix: () => '/usr/local',
    platform: () => 'linux',
    accessSync: ((path: string) => {
      checked.push(path);
    }) as unknown as typeof import('node:fs').accessSync,
  });

  assert.equal(result, true);
  assert.deepEqual(checked, ['/usr/local/lib/node_modules']);
});

test('canWriteGlobalNpmRoot checks <prefix>\\node_modules on Windows', () => {
  const checked: string[] = [];

  canWriteGlobalNpmRoot({
    npmGlobalPrefix: () => 'C:\\Users\\me\\AppData\\Roaming\\npm',
    platform: () => 'win32',
    accessSync: ((path: string) => {
      checked.push(path);
    }) as unknown as typeof import('node:fs').accessSync,
  });

  assert.equal(checked.length, 1);
  assert.match(checked[0] ?? '', /node_modules$/);
});

test('canWriteGlobalNpmRoot reports false when the global modules root is not writable', () => {
  const result = canWriteGlobalNpmRoot({
    npmGlobalPrefix: () => '/usr/local',
    platform: () => 'linux',
    accessSync: eacces as unknown as typeof import('node:fs').accessSync,
  });

  assert.equal(result, false);
});

test('canWriteGlobalNpmRoot walks up to the nearest existing directory', () => {
  const checked: string[] = [];

  const result = canWriteGlobalNpmRoot({
    npmGlobalPrefix: () => '/usr/local',
    platform: () => 'linux',
    accessSync: ((path: string) => {
      checked.push(path);
      if (path !== '/usr') {
        enoent();
      }
    }) as unknown as typeof import('node:fs').accessSync,
  });

  assert.equal(result, true);
  assert.deepEqual(checked, ['/usr/local/lib/node_modules', '/usr/local/lib', '/usr/local', '/usr']);
});

test('canWriteGlobalNpmRoot fails open when the prefix cannot be resolved', () => {
  assert.equal(
    canWriteGlobalNpmRoot({
      npmGlobalPrefix: () => null,
      platform: () => 'linux',
      accessSync: eacces as unknown as typeof import('node:fs').accessSync,
    }),
    true,
  );

  assert.equal(
    canWriteGlobalNpmRoot({
      npmGlobalPrefix: () => {
        throw new Error('npm prefix -g failed');
      },
      platform: () => 'linux',
      accessSync: eacces as unknown as typeof import('node:fs').accessSync,
    }),
    true,
  );
});
