import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRunnerWorkingDirectory } from './working-directory.js';

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'working-directory-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('checkRunnerWorkingDirectory rejects a missing authPath', () => {
  for (const value of [null, undefined, '', '   ']) {
    const result = checkRunnerWorkingDirectory(value);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.code, 'MISSING_AUTH_PATH');
  }
});

test('checkRunnerWorkingDirectory rejects a path that does not exist on this runner', () => {
  const result = checkRunnerWorkingDirectory('/missing/workspace', {
    pathExists: () => false,
    isGitRepo: () => true,
  });

  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.code, 'DIRECTORY_NOT_FOUND');
  assert.match(result.valid === false ? result.reason : '', /does not exist on this runner/);
  assert.match(result.valid === false ? result.reason : '', /machine where this agent was registered/);
});

test('checkRunnerWorkingDirectory accepts a directory that has the AgentTeams project marker', () => {
  const checkedPaths: string[] = [];
  const result = checkRunnerWorkingDirectory('/workspace', {
    pathExists: (path) => {
      checkedPaths.push(path);
      return true;
    },
    isGitRepo: () => {
      throw new Error('isGitRepo should not run once the project marker is found');
    },
  });

  assert.deepEqual(result, { valid: true });
  assert.deepEqual(checkedPaths, ['/workspace', join('/workspace', '.agentteams', 'config.json')]);
});

test('checkRunnerWorkingDirectory accepts a git repository without the project marker', () => {
  const result = checkRunnerWorkingDirectory('/workspace', {
    pathExists: (path) => path === '/workspace',
    isGitRepo: () => true,
  });

  assert.deepEqual(result, { valid: true });
});

test('checkRunnerWorkingDirectory rejects a directory that is neither a git repo nor a project', () => {
  const result = checkRunnerWorkingDirectory('/workspace', {
    pathExists: (path) => path === '/workspace',
    isGitRepo: () => false,
  });

  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.code, 'NOT_A_PROJECT_DIRECTORY');
  assert.match(result.valid === false ? result.reason : '', /\.agentteams[\\/]config\.json/);
});

test('checkRunnerWorkingDirectory rejects a marker that belongs to a different project', () => {
  const result = checkRunnerWorkingDirectory('/workspace', {
    pathExists: () => true,
    isGitRepo: () => {
      throw new Error('the git fallback must not rescue a project mismatch');
    },
    readProjectMarker: () => JSON.stringify({ projectId: 'other-project' }),
    expectedProjectId: 'this-project',
  });

  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.code, 'PROJECT_MISMATCH');
  assert.match(result.valid === false ? result.reason : '', /other-project/);
  assert.match(result.valid === false ? result.reason : '', /this-project/);
});

test('checkRunnerWorkingDirectory accepts a marker whose projectId matches the trigger', () => {
  const result = checkRunnerWorkingDirectory('/workspace', {
    pathExists: () => true,
    isGitRepo: () => {
      throw new Error('isGitRepo should not run once the project marker matches');
    },
    readProjectMarker: () => JSON.stringify({ projectId: 'this-project' }),
    expectedProjectId: 'this-project',
  });

  assert.deepEqual(result, { valid: true });
});

test('checkRunnerWorkingDirectory falls back to the git check when the marker is unreadable', () => {
  // 마커를 읽지 못하거나 projectId가 없으면 "다른 프로젝트"라고 단정할 수 없으므로 기존 판정으로 내려간다.
  for (const marker of [null, 'not json', JSON.stringify({ teamId: 'team-1' })]) {
    const result = checkRunnerWorkingDirectory('/workspace', {
      pathExists: () => true,
      isGitRepo: () => false,
      readProjectMarker: () => marker,
      expectedProjectId: 'this-project',
    });

    assert.deepEqual(result, { valid: true }, `marker=${String(marker)}`);
  }
});

test('checkRunnerWorkingDirectory skips the project check when the trigger has no projectId', () => {
  const result = checkRunnerWorkingDirectory('/workspace', {
    pathExists: () => true,
    isGitRepo: () => false,
    readProjectMarker: () => JSON.stringify({ projectId: 'other-project' }),
    expectedProjectId: null,
  });

  assert.deepEqual(result, { valid: true });
});

test('checkRunnerWorkingDirectory judges real directories without creating anything', async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, 'not-created');
    const missingResult = checkRunnerWorkingDirectory(missing);
    assert.equal(missingResult.valid, false);
    assert.equal(missingResult.valid === false && missingResult.code, 'DIRECTORY_NOT_FOUND');
    assert.equal(existsSync(missing), false);

    const emptyDir = join(dir, 'empty');
    await mkdir(emptyDir);
    const emptyResult = checkRunnerWorkingDirectory(emptyDir);
    assert.equal(emptyResult.valid, false);
    assert.equal(emptyResult.valid === false && emptyResult.code, 'NOT_A_PROJECT_DIRECTORY');

    const markerDir = join(dir, 'marker');
    await mkdir(join(markerDir, '.agentteams'), { recursive: true });
    await writeFile(join(markerDir, '.agentteams', 'config.json'), '{}\n', 'utf8');
    assert.deepEqual(checkRunnerWorkingDirectory(markerDir), { valid: true });

    const otherProjectDir = join(dir, 'other-project');
    await mkdir(join(otherProjectDir, '.agentteams'), { recursive: true });
    await writeFile(
      join(otherProjectDir, '.agentteams', 'config.json'),
      `${JSON.stringify({ projectId: 'project-b' })}\n`,
      'utf8',
    );
    const mismatchResult = checkRunnerWorkingDirectory(otherProjectDir, { expectedProjectId: 'project-a' });
    assert.equal(mismatchResult.valid, false);
    assert.equal(mismatchResult.valid === false && mismatchResult.code, 'PROJECT_MISMATCH');
    assert.deepEqual(checkRunnerWorkingDirectory(otherProjectDir, { expectedProjectId: 'project-b' }), {
      valid: true,
    });

    const repoDir = join(dir, 'repo');
    await mkdir(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    assert.deepEqual(checkRunnerWorkingDirectory(repoDir), { valid: true });

    const worktreeParent = join(repoDir, 'nested');
    await mkdir(worktreeParent);
    assert.deepEqual(checkRunnerWorkingDirectory(worktreeParent), { valid: true });
  });
});
