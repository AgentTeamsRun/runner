import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { findMemberRepoCandidates, normalizeRemoteUrl, resolveWorktreeAuthPath } from './resolve-member-repo.js';

const makeTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const initGitRepo = (dir: string, originUrl?: string): void => {
  execFileSync('git', ['init', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'initial'], { stdio: 'pipe' });
  if (originUrl) {
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { stdio: 'pipe' });
  }
};

const cleanupDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

test('normalizeRemoteUrl unifies https, scp-ssh, and ssh scheme forms', () => {
  const expected = 'github.com/rlarua/kma-ui';
  assert.equal(normalizeRemoteUrl('https://github.com/rlarua/kma-ui.git'), expected);
  assert.equal(normalizeRemoteUrl('https://github.com/rlarua/kma-ui'), expected);
  assert.equal(normalizeRemoteUrl('https://github.com/rlarua/kma-ui/'), expected);
  assert.equal(normalizeRemoteUrl('git@github.com:rlarua/kma-ui.git'), expected);
  assert.equal(normalizeRemoteUrl('ssh://git@github.com/rlarua/kma-ui.git'), expected);
  assert.equal(normalizeRemoteUrl('ssh://git@github.com:22/rlarua/kma-ui.git'), expected);
  assert.equal(normalizeRemoteUrl('HTTPS://GitHub.com/RLarua/KMA-UI.git'), expected);
});

// custom port는 서버 신원의 일부다: 같은 호스트의 다른 포트는 다른 Git 서버이므로
// 불일치해야 하고, 프로토콜 기본 포트만 무포트 URL과 일치한다.
test('normalizeRemoteUrl keeps non-default ports and strips protocol-default ports', () => {
  assert.equal(normalizeRemoteUrl('https://git.example.com:8443/team/repo.git'), 'git.example.com:8443/team/repo');
  assert.notEqual(
    normalizeRemoteUrl('https://git.example.com:8443/team/repo.git'),
    normalizeRemoteUrl('https://git.example.com:9443/team/repo.git'),
  );
  assert.notEqual(
    normalizeRemoteUrl('https://git.example.com:8443/team/repo.git'),
    normalizeRemoteUrl('https://git.example.com/team/repo.git'),
  );

  // Explicit default ports match the port-less form.
  assert.equal(normalizeRemoteUrl('https://git.example.com:443/team/repo.git'), 'git.example.com/team/repo');
  assert.equal(normalizeRemoteUrl('http://git.example.com:80/team/repo.git'), 'git.example.com/team/repo');
  assert.equal(normalizeRemoteUrl('ssh://git@git.example.com:22/team/repo.git'), 'git.example.com/team/repo');
  assert.equal(normalizeRemoteUrl('git://git.example.com:9418/team/repo.git'), 'git.example.com/team/repo');

  // Non-default ssh port stays part of the identity.
  assert.equal(normalizeRemoteUrl('ssh://git@git.example.com:2222/team/repo.git'), 'git.example.com:2222/team/repo');
});

test('normalizeRemoteUrl rejects empty or unrecognizable values', () => {
  assert.equal(normalizeRemoteUrl(''), null);
  assert.equal(normalizeRemoteUrl('   '), null);
  assert.equal(normalizeRemoteUrl('not a url'), null);
  assert.equal(normalizeRemoteUrl('git@github.com:'), null);
});

// 판정 기준 계약 테스트: CLI findMemberRepos(cli/src/utils/projectLayout.ts)와 동일하게
// 1뎁스 물리 디렉터리만 후보로 삼고 숨김/node_modules/심링크/비-git/중첩 작업트리를 제외한다.
test('findMemberRepoCandidates matches the CLI findMemberRepos judgement contract', () => {
  const root = makeTempDir('resolve-member-contract-');
  try {
    // Included: plain member git repos at depth 1
    initGitRepo(join(root, 'repo-a'));
    initGitRepo(join(root, 'repo-b'));

    // Excluded: hidden directory, even if it is a git repo
    initGitRepo(join(root, '.hidden-repo'));

    // Excluded: node_modules, even if it is a git repo
    initGitRepo(join(root, 'node_modules'));

    // Excluded: non-git plain directory
    mkdirSync(join(root, 'plain-dir'));

    // Excluded: plain file
    writeFileSync(join(root, 'README.md'), '# root');

    // Excluded: symlinked directory pointing at a real git repo
    symlinkSync(join(root, 'repo-a'), join(root, 'linked-repo'), 'dir');

    // Excluded: directory that is merely inside another repository's work tree
    mkdirSync(join(root, 'repo-a', 'nested'));

    const candidates = findMemberRepoCandidates(root);
    assert.deepEqual(
      candidates.map((candidate) => basename(candidate)),
      ['repo-a', 'repo-b'],
    );
  } finally {
    cleanupDir(root);
  }
});

test('findMemberRepoCandidates returns empty list for unreadable root', () => {
  assert.deepEqual(findMemberRepoCandidates(join(tmpdir(), `nonexistent-${Date.now()}`)), []);
});

test('resolveWorktreeAuthPath returns authPath as-is when it is a git repository', () => {
  const repo = makeTempDir('resolve-member-git-');
  try {
    initGitRepo(repo);
    assert.deepEqual(resolveWorktreeAuthPath(repo, null), { path: repo });
  } finally {
    cleanupDir(repo);
  }
});

test('resolveWorktreeAuthPath resolves the single member repo matching remoteUrl', () => {
  const root = makeTempDir('resolve-member-match-');
  try {
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');
    initGitRepo(join(root, 'kma-api'), 'git@github.com:rlarua/kma-api.git');

    const resolution = resolveWorktreeAuthPath(root, 'https://github.com/rlarua/kma-ui.git');
    assert.deepEqual(resolution, { path: join(root, 'kma-ui') });
  } finally {
    cleanupDir(root);
  }
});

test('resolveWorktreeAuthPath fails with guidance when remoteUrl is null', () => {
  const root = makeTempDir('resolve-member-null-');
  try {
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');

    const resolution = resolveWorktreeAuthPath(root, null);
    assert.ok('error' in resolution);
    assert.match(resolution.error, /has no remote URL/);
    assert.match(resolution.error, /Turn off the runner box/);
    assert.doesNotMatch(resolution.error, /git init/);
  } finally {
    cleanupDir(root);
  }
});

test('resolveWorktreeAuthPath fails with guidance when no member repo matches', () => {
  const root = makeTempDir('resolve-member-none-');
  try {
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');

    const resolution = resolveWorktreeAuthPath(root, 'https://github.com/rlarua/other-repo.git');
    assert.ok('error' in resolution);
    assert.match(resolution.error, /no member repository/);
    assert.match(resolution.error, /Turn off the runner box/);
    assert.doesNotMatch(resolution.error, /git init/);
  } finally {
    cleanupDir(root);
  }
});

test('resolveWorktreeAuthPath fails with guidance when multiple member repos match', () => {
  const root = makeTempDir('resolve-member-dup-');
  try {
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');
    initGitRepo(join(root, 'kma-ui-copy'), 'https://github.com/rlarua/kma-ui.git');

    const resolution = resolveWorktreeAuthPath(root, 'https://github.com/rlarua/kma-ui.git');
    assert.ok('error' in resolution);
    assert.match(resolution.error, /multiple member repositories/);
    assert.match(resolution.error, /kma-ui/);
    assert.match(resolution.error, /kma-ui-copy/);
    assert.match(resolution.error, /Turn off the runner box/);
  } finally {
    cleanupDir(root);
  }
});

test('resolveWorktreeAuthPath fails when the remote URL is unrecognizable', () => {
  const root = makeTempDir('resolve-member-badurl-');
  try {
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');

    const resolution = resolveWorktreeAuthPath(root, 'not a url');
    assert.ok('error' in resolution);
    assert.match(resolution.error, /not recognized/);
    assert.match(resolution.error, /Turn off the runner box/);
  } finally {
    cleanupDir(root);
  }
});

// 오류 메시지는 TriggerLogReporter/worktreeError로 서버에 영구 전송되므로
// credential 포함 remote URL의 비밀값이 어떤 실패 경로에서도 노출되면 안 된다.
test('resolveWorktreeAuthPath never leaks credentials from the remote URL into errors', () => {
  const root = makeTempDir('resolve-member-cred-');
  try {
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');
    initGitRepo(join(root, 'other-a'), 'https://github.com/rlarua/other.git');
    initGitRepo(join(root, 'other-b'), 'git@github.com:rlarua/other.git');

    const secret = 'user:s3cret-token';

    // Zero matches
    const none = resolveWorktreeAuthPath(root, `https://${secret}@example.com/team/none.git`);
    assert.ok('error' in none);
    assert.doesNotMatch(none.error, /s3cret-token/);
    assert.match(none.error, /example\.com\/team\/none/);

    // Multiple matches
    const dup = resolveWorktreeAuthPath(root, `https://${secret}@github.com/rlarua/other.git`);
    assert.ok('error' in dup);
    assert.doesNotMatch(dup.error, /s3cret-token/);
    assert.match(dup.error, /github\.com\/rlarua\/other/);

    // Unrecognizable URL: raw value must not be echoed at all
    const bad = resolveWorktreeAuthPath(root, `://${secret}@:not-a-url`);
    assert.ok('error' in bad);
    assert.doesNotMatch(bad.error, /s3cret-token/);
    assert.match(bad.error, /not recognized/);
  } finally {
    cleanupDir(root);
  }
});

test('resolveWorktreeAuthPath ignores member repos without an origin remote', () => {
  const root = makeTempDir('resolve-member-no-origin-');
  try {
    initGitRepo(join(root, 'no-origin'));
    initGitRepo(join(root, 'kma-ui'), 'git@github.com:rlarua/kma-ui.git');

    const resolution = resolveWorktreeAuthPath(root, 'https://github.com/rlarua/kma-ui.git');
    assert.deepEqual(resolution, { path: join(root, 'kma-ui') });
  } finally {
    cleanupDir(root);
  }
});
