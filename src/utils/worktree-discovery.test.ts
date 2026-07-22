import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  computeLocalKey,
  discoverRepositoryWorktrees,
  parseWorktreePorcelain,
  reconcileDiscoveredWorktrees,
  type RepositoryDiscovery,
} from './worktree-discovery.js';
import type { DiscoveredWorktreeSyncRepository, DiscoveryRepository } from '../types.js';

// `git worktree list --porcelain -z`는 attribute를 NUL로 종료하고 record를 빈 attribute(연속 NUL)로 구분한다.
const rec = (lines: string[]): string => lines.map((l) => `${l}\0`).join('') + '\0';

test('parseWorktreePorcelain: main + linked + detached + locked', () => {
  const output =
    rec(['worktree /repo/main', 'HEAD aaa111', 'branch refs/heads/main']) +
    rec(['worktree /repo/.wt/feature', 'HEAD bbb222', 'branch refs/heads/feature/x']) +
    rec(['worktree /repo/.wt/detached', 'HEAD ccc333', 'detached']) +
    rec(['worktree /repo/.wt/locked', 'HEAD ddd444', 'branch refs/heads/locked-wt', 'locked']);

  const records = parseWorktreePorcelain(output);
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((r) => r.path),
    ['/repo/main', '/repo/.wt/feature', '/repo/.wt/detached', '/repo/.wt/locked'],
  );
  assert.equal(records[1].branch, 'feature/x');
  assert.equal(records[2].detached, true);
  assert.equal(records[2].branch, null);
  assert.equal(records[3].locked, true);
  assert.equal(records[3].branch, 'locked-wt');
});

test('parseWorktreePorcelain: prunable and bare flags', () => {
  const output =
    rec(['worktree /repo/main', 'HEAD aaa', 'bare']) +
    rec([
      'worktree /repo/.wt/gone',
      'HEAD bbb',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
    ]);
  const records = parseWorktreePorcelain(output);
  assert.equal(records[0].bare, true);
  assert.equal(records[1].prunable, true);
});

test('parseWorktreePorcelain: whitespace, non-ASCII, and Windows paths', () => {
  const output =
    rec(['worktree /repo/main', 'HEAD a', 'branch refs/heads/main']) +
    rec(['worktree /repo/.wt/with space', 'HEAD b', 'branch refs/heads/spaced']) +
    rec(['worktree /repo/.wt/한글-브랜치', 'HEAD c', 'branch refs/heads/한글']) +
    rec(['worktree C:\\Users\\dev\\repo\\.wt\\win', 'HEAD d', 'branch refs/heads/win']);
  const records = parseWorktreePorcelain(output);
  assert.equal(records[1].path, '/repo/.wt/with space');
  assert.equal(records[2].path, '/repo/.wt/한글-브랜치');
  assert.equal(records[2].branch, '한글');
  assert.equal(records[3].path, 'C:\\Users\\dev\\repo\\.wt\\win');
});

test('discoverRepositoryWorktrees: excludes main/bare/prunable and maps linked worktrees', () => {
  const output =
    rec(['worktree /repo/main', 'HEAD aaa', 'branch refs/heads/main']) +
    rec(['worktree /repo/.wt/feature', 'HEAD bbb', 'branch refs/heads/feature/x']) +
    rec(['worktree /repo/.wt/gone', 'HEAD ccc', 'branch refs/heads/gone', 'prunable reason']);

  const result = discoverRepositoryWorktrees('/repo/main', () => output);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.branch, 'feature/x');
  assert.equal(item.headSha, 'bbb');
  // localKey는 canonical 경로 해시. mapping은 절대 경로를 보관한다(서버로는 전송하지 않음).
  assert.ok(result.mappings[item.localKey]);
  assert.equal(item.localKey.length, 64);
});

test('discoverRepositoryWorktrees: git failure returns ok=false to preserve server state', () => {
  const result = discoverRepositoryWorktrees('/repo/main', () => {
    throw new Error('git not a repository');
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.items, []);
});

test('discoverRepositoryWorktrees: malformed successful output returns ok=false to preserve server state', () => {
  for (const output of ['', 'garbage\0\0', 'worktree /repo/main\0HEAD abc\0']) {
    const result = discoverRepositoryWorktrees('/repo/main', () => output);
    assert.equal(result.ok, false);
    assert.deepEqual(result.items, []);
  }
});

test('reconcileDiscoveredWorktrees: only in-scope repositories are reported; git failure reported as ok=false', async () => {
  const repositories: DiscoveryRepository[] = [
    { id: 'repo-a', projectId: 'p1', remoteUrl: 'https://example.com/acme/a.git' },
    { id: 'repo-b', projectId: 'p1', remoteUrl: 'https://example.com/acme/b.git' },
    // remoteUrl 없음 → 매칭 불가
    { id: 'repo-c', projectId: 'p1', remoteUrl: null },
  ];

  let synced: DiscoveredWorktreeSyncRepository[] | null = null;
  const savedMappings: Record<string, string>[] = [];

  await reconcileDiscoveredWorktrees({
    fetchDiscoveryRepositories: async () => repositories,
    syncDiscoveredWorktrees: async (repos) => {
      synced = repos;
    },
    authPaths: ['/auth/a', '/auth/b', '/auth/out-of-scope'],
    isGitRepo: () => true,
    // 각 authPath가 자체 git repo. origin으로 repo 신원 매칭.
    resolveRepositoryOrigin: (repoPath) => {
      if (repoPath === '/auth/a') return 'example.com/acme/a';
      if (repoPath === '/auth/b') return 'example.com/acme/b';
      return 'example.com/acme/unknown'; // scope 밖
    },
    discoverRepositoryWorktrees: (repoPath): RepositoryDiscovery => {
      if (repoPath === '/auth/a') {
        return {
          ok: true,
          items: [{ localKey: 'k-a', branch: 'feat/a', headSha: 'a1', displayName: 'feat/a' }],
          mappings: { 'k-a': '/auth/a/.wt/x' },
        };
      }
      // repo-b: git 조회 실패
      return { ok: false, items: [], mappings: {} };
    },
    loadMappings: () => ({}),
    saveMappings: (m) => savedMappings.push(m),
  });

  assert.ok(synced);
  const reported = synced as unknown as DiscoveredWorktreeSyncRepository[];
  // out-of-scope repo는 보고되지 않는다.
  const ids = reported.map((r) => r.repositoryId).sort();
  assert.deepEqual(ids, ['repo-a', 'repo-b']);
  const a = reported.find((r) => r.repositoryId === 'repo-a')!;
  assert.equal(a.ok, true);
  assert.equal(a.worktrees.length, 1);
  const b = reported.find((r) => r.repositoryId === 'repo-b')!;
  assert.equal(b.ok, false);
  assert.deepEqual(b.worktrees, []);
  // 매핑이 원자적으로 저장된다.
  assert.deepEqual(savedMappings.at(-1), { 'k-a': '/auth/a/.wt/x' });
});

test('reconcileDiscoveredWorktrees: no local match reports nothing (avoids false MISSING)', async () => {
  let synced: DiscoveredWorktreeSyncRepository[] | null = null;
  await reconcileDiscoveredWorktrees({
    fetchDiscoveryRepositories: async () => [{ id: 'repo-x', projectId: 'p', remoteUrl: 'https://example.com/x.git' }],
    syncDiscoveredWorktrees: async (repos) => {
      synced = repos;
    },
    authPaths: ['/auth/unrelated'],
    isGitRepo: () => true,
    resolveRepositoryOrigin: () => 'example.com/unrelated', // no match
    discoverRepositoryWorktrees: () => ({ ok: true, items: [], mappings: {} }),
    loadMappings: () => ({}),
    saveMappings: () => {},
  });
  // 매칭 repository가 없으면 sync 자체를 호출하지 않는다.
  assert.equal(synced, null);
});

test('reconcileDiscoveredWorktrees fans one remote snapshot out to every matching project repository', async () => {
  let synced: DiscoveredWorktreeSyncRepository[] = [];
  await reconcileDiscoveredWorktrees({
    fetchDiscoveryRepositories: async () => [
      { id: 'repo-project-a', projectId: 'a', remoteUrl: 'https://example.com/shared.git' },
      { id: 'repo-project-b', projectId: 'b', remoteUrl: 'git@example.com:shared.git' },
    ],
    syncDiscoveredWorktrees: async (repositories) => {
      synced = repositories;
    },
    authPaths: ['/auth/shared'],
    isGitRepo: () => true,
    resolveRepositoryOrigin: () => 'example.com/shared',
    discoverRepositoryWorktrees: () => ({
      ok: true,
      items: [{ localKey: 'shared-key', branch: 'feature/shared', headSha: 'abc', displayName: 'shared' }],
      mappings: { 'shared-key': '/auth/shared-wt' },
    }),
    loadMappings: () => ({}),
    saveMappings: () => {},
  });

  assert.deepEqual(synced.map((repository) => repository.repositoryId).sort(), ['repo-project-a', 'repo-project-b']);
  assert.ok(synced.every((repository) => repository.worktrees[0]?.localKey === 'shared-key'));
});

test('end-to-end: linked worktree added by another tool is discovered without Orca', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-discovery-'));
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.com'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'T'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });

    // 외부 도구 방식: 직접 git worktree add
    const wtPath = join(root, 'external-wt');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'external/feature', wtPath], { stdio: 'pipe' });

    const result = discoverRepositoryWorktrees(repo);
    assert.equal(result.ok, true);
    // main은 제외, 외부 linked worktree만 발견
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].branch, 'external/feature');
    const mappedPath = result.mappings[result.items[0].localKey];
    assert.ok(mappedPath);
    // localKey는 canonical 경로 해시와 일치
    assert.equal(computeLocalKey(mappedPath), result.items[0].localKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
