import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getAuthPathStorePath, loadAuthPaths, saveAuthPath } from './auth-path-store.js';

const envKeys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;

const withTempHome = async (run: (homeDir: string) => Promise<void>): Promise<void> => {
  const previousEnv = new Map<string, string | undefined>();
  for (const key of envKeys) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  const homeDir = await mkdtemp(join(tmpdir(), 'auth-path-store-test-'));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.HOMEDRIVE = '';
  process.env.HOMEPATH = '';

  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test('loadAuthPaths returns an empty array when the store does not exist', async () => {
  await withTempHome(async () => {
    assert.deepEqual(loadAuthPaths(), []);
  });
});

test('saveAuthPath persists unique auth paths in the daemon home directory', async () => {
  await withTempHome(async (homeDir) => {
    const expectedPath = join(homeDir, '.agentteams', 'auth-paths.json');

    const savedPath = saveAuthPath('/repo/one');
    saveAuthPath('/repo/one');
    saveAuthPath('/repo/two');

    assert.equal(savedPath, expectedPath);
    assert.equal(getAuthPathStorePath(), expectedPath);
    assert.deepEqual(loadAuthPaths(), ['/repo/one', '/repo/two']);

    const content = JSON.parse(await readFile(expectedPath, 'utf8')) as { authPaths: string[] };
    assert.deepEqual(content, {
      authPaths: ['/repo/one', '/repo/two'],
    });
  });
});

test('loadAuthPaths tolerates invalid or legacy store formats', async () => {
  await withTempHome(async () => {
    const filePath = getAuthPathStorePath();
    await mkdir(join(filePath, '..'), { recursive: true });

    await writeFile(filePath, '{invalid', 'utf8');
    assert.deepEqual(loadAuthPaths(), []);

    await writeFile(filePath, JSON.stringify(['/repo/one', '/repo/one', 123]), 'utf8');
    assert.deepEqual(loadAuthPaths(), ['/repo/one']);
  });
});
