import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMachineId, getMachineIdPath, readOrCreateMachineId, resetMachineIdCache } from './machine-id.js';

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'machine-id-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('getMachineIdPath points at the file shared by the runner and the CLI', () => {
  assert.equal(getMachineIdPath(), join(homedir(), '.agentteams', 'machine-id'));
});

test('readOrCreateMachineId creates the file once and reuses the value afterwards', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'machine-id');

    const first = readOrCreateMachineId({ path });
    assert.ok(first);
    assert.match(first, /^[0-9a-f-]{36}$/);

    const stored = await readFile(path, 'utf8');
    assert.equal(stored.trim(), first);

    const second = readOrCreateMachineId({ path });
    assert.equal(second, first);
  });
});

test('readOrCreateMachineId writes the file with owner-only permissions', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file mode is not meaningful on Windows');
    return;
  }

  await withTempDir(async (dir) => {
    const path = join(dir, 'machine-id');
    readOrCreateMachineId({ path });
    const stats = await stat(path);
    assert.equal(stats.mode & 0o777, 0o600);
  });
});

test('readOrCreateMachineId trims surrounding whitespace from an existing file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'machine-id');
    await writeFile(path, '  existing-machine-id\n', 'utf8');

    assert.equal(readOrCreateMachineId({ path }), 'existing-machine-id');
  });
});

test('readOrCreateMachineId regenerates when the existing file is blank', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'machine-id');
    await writeFile(path, '\n', 'utf8');

    const resolved = readOrCreateMachineId({ path });
    assert.ok(resolved);
    assert.equal((await readFile(path, 'utf8')).trim(), resolved);
  });
});

test('readOrCreateMachineId returns the value written by a racing process', () => {
  let fileContent: string | null = null;
  const resolved = readOrCreateMachineId({
    path: '/machine-id',
    readFile: () => {
      if (fileContent === null) {
        // 첫 읽기는 파일이 없는 상태를 흉내낸다. 이후에는 경쟁 프로세스가 쓴 값이 보인다.
        fileContent = 'winner-machine-id\n';
        throw new Error('ENOENT');
      }
      return fileContent;
    },
    writeFileExclusive: () => {
      throw new Error('EEXIST');
    },
    generateId: () => 'loser-machine-id',
  });

  assert.equal(resolved, 'winner-machine-id');
});

test('readOrCreateMachineId returns null when the file can be neither read nor written', () => {
  const resolved = readOrCreateMachineId({
    path: '/machine-id',
    readFile: () => {
      throw new Error('EACCES');
    },
    writeFileExclusive: () => {
      throw new Error('EACCES');
    },
  });

  assert.equal(resolved, null);
});

test('getMachineId caches the resolved value for the process lifetime', () => {
  resetMachineIdCache();
  const first = getMachineId();
  const second = getMachineId();

  assert.equal(second, first);
  assert.ok(first);
});
