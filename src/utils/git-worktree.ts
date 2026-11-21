import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { findMemberRepoCandidates, isGitRepo, normalizeRemoteUrl } from './resolve-member-repo.js';

// 동기 git 조회는 이 헬퍼를 통해 실행한다. windowsHide 누락 시 Windows에서
// 콘솔 미부착 부모(데몬) 프로세스가 git.exe를 띄울 때 콘솔 창이 잠깐 노출된다.
function runGit(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true });
}

export { isGitRepo };

/**
 * `repository`는 커밋이 기록된 저장소의 정규화 식별자(`host/owner/repo`)다.
 * 구버전 API·레거시 레코드에서는 비어 있다.
 */
export type ExpectedCommit = { commit: string; branch: string | null; repository?: string | null };

export type GitPreflightMissing = { kind: 'baseBranch' | 'commit'; ref: string };

export type PreflightGitStateInput = {
  repoPath: string;
  /** 멤버 저장소를 찾을 작업 공간 루트. 생략하면 `repoPath`. */
  workspaceRoot?: string;
  baseBranch?: string | null;
  expectedCommits?: ExpectedCommit[];
  fetchTimeoutMs?: number;
  signal?: AbortSignal;
  /** 테스트 주입용. 기본은 `git fetch origin --prune`. */
  fetchOrigin?: (repoPath: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<void>;
};

const resolveGitCommit = (repoPath: string, ref: string): string | null => {
  try {
    return runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], repoPath)
      .toString()
      .trim();
  } catch {
    return null;
  }
};

export function resolveBaseCommit(repoPath: string, baseBranch: string): string | null {
  const ref = baseBranch.trim();
  if (!ref) return null;
  return resolveGitCommit(repoPath, ref) ?? resolveGitCommit(repoPath, `refs/remotes/origin/${ref}`);
}

const gitCommitExists = (repoPath: string, commit: string): boolean => {
  try {
    runGit(['cat-file', '-e', `${commit}^{commit}`], repoPath);
    return true;
  } catch {
    return false;
  }
};

const fetchOriginPrune = (repoPath: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile(
      'git',
      ['fetch', 'origin', '--prune'],
      {
        cwd: repoPath,
        windowsHide: true,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        signal: options.signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });

const readOriginRepository = (repoPath: string): string | null => {
  try {
    return normalizeRemoteUrl(runGit(['remote', 'get-url', 'origin'], repoPath).toString());
  } catch {
    return null;
  }
};

/**
 * 러너 시작 전 base 브랜치와 이전 태스크 커밋(`expectedCommits`)이 로컬에서 보이는지 확인한다.
 *
 * 커밋마다 검사할 저장소를 고른다. 멀티 저장소 작업 공간에서는 `repoPath`가 git이 아니거나
 * (RunnerBox 끔) 다른 멤버 저장소일 수 있어(RunnerBox 켬), `workspaceRoot` 바로 아래 멤버 저장소를
 * 함께 본다.
 * - `repository`가 `repoPath`의 origin과 같거나 비어 있으면 `repoPath`.
 * - `repository`가 있으면 origin이 일치하는 멤버 저장소.
 * - `repository`가 없는 레거시 항목은 멤버 저장소 전체에서 커밋 객체만 찾는다.
 * 원격 브랜치 이름으로 통과시키는 것은 대상 저장소가 확정된 경우에만 허용한다(같은 브랜치명이
 * 여러 저장소에 있을 수 있다). fetch는 저장소마다 한 번만 하고, 실패하면 경고 후 로컬 참조로 판정한다.
 */
export async function preflightGitState(
  input: PreflightGitStateInput,
): Promise<{ missing: GitPreflightMissing[]; baseCommit: string | null }> {
  input.signal?.throwIfAborted();
  const fetchOrigin = input.fetchOrigin ?? fetchOriginPrune;
  const fetchedRepoPaths = new Set<string>();
  const ensureFetched = async (repoPath: string): Promise<void> => {
    const key = path.resolve(repoPath);
    if (fetchedRepoPaths.has(key)) return;
    fetchedRepoPaths.add(key);
    try {
      await fetchOrigin(repoPath, { timeoutMs: input.fetchTimeoutMs ?? 30_000, signal: input.signal });
    } catch (error) {
      input.signal?.throwIfAborted();
      logger.warn('Git fetch origin --prune failed; continuing with local refs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    input.signal?.throwIfAborted();
  };

  const repoPathIsGit = isGitRepo(input.repoPath);
  if (repoPathIsGit) {
    await ensureFetched(input.repoPath);
  }

  input.signal?.throwIfAborted();
  const missing: GitPreflightMissing[] = [];
  const baseBranch = input.baseBranch?.trim() ?? '';
  const baseCommit = baseBranch ? resolveBaseCommit(input.repoPath, baseBranch) : null;
  if (baseBranch && !baseCommit) {
    missing.push({ kind: 'baseBranch', ref: baseBranch });
  }

  const expectedCommits = input.expectedCommits ?? [];
  const needsMembers = expectedCommits.some((item) => !repoPathIsGit || Boolean(item.repository));
  const repoPathRepository = repoPathIsGit && needsMembers ? readOriginRepository(input.repoPath) : null;
  let members: Array<{ path: string; repository: string | null }> | null = null;
  const listMembers = () => {
    members ??= findMemberRepoCandidates(input.workspaceRoot ?? input.repoPath)
      .filter((memberPath) => path.resolve(memberPath) !== path.resolve(input.repoPath))
      .map((memberPath) => ({ path: memberPath, repository: readOriginRepository(memberPath) }));
    return members;
  };

  const existsInConfirmedRepo = async (repoPath: string, item: ExpectedCommit): Promise<boolean> => {
    await ensureFetched(repoPath);
    if (gitCommitExists(repoPath, item.commit)) return true;
    const branch = item.branch?.trim();
    return Boolean(branch && resolveGitCommit(repoPath, `refs/remotes/origin/${branch}`));
  };

  const existsInAnyMember = async (item: ExpectedCommit): Promise<boolean> => {
    const candidates = listMembers();
    if (candidates.some((member) => gitCommitExists(member.path, item.commit))) return true;
    // 로컬에 없을 때만 fetch한다. 다른 러너가 커밋·푸시한 경우를 위한 것이다.
    for (const member of candidates) {
      await ensureFetched(member.path);
      if (gitCommitExists(member.path, item.commit)) return true;
    }
    return false;
  };

  for (const item of expectedCommits) {
    const repository = item.repository?.trim() || null;
    let found = false;

    if (repoPathIsGit && (!repository || repoPathRepository === repository)) {
      found = await existsInConfirmedRepo(input.repoPath, item);
    }
    if (!found && repository) {
      for (const member of listMembers()) {
        if (member.repository !== repository) continue;
        found = await existsInConfirmedRepo(member.path, item);
        if (found) break;
      }
      // origin 표기가 기록 시점과 달라 매칭되지 않은 경우를 위해 실행 저장소의 커밋 객체는 확인한다.
      if (!found && repoPathIsGit && repoPathRepository !== repository) {
        found = gitCommitExists(input.repoPath, item.commit);
      }
    }
    if (!found && !repository) {
      found = await existsInAnyMember(item);
    }

    if (!found) {
      missing.push({ kind: 'commit', ref: item.commit });
    }
  }

  return { missing, baseCommit };
}

export function resolveWorktreePath(authPath: string, worktreeId: string): string {
  if (/[\/\\]|\.\./.test(worktreeId)) {
    throw new Error('Invalid worktreeId: path traversal characters detected');
  }
  const repoName = path.basename(authPath);
  return path.join(path.dirname(authPath), `.${repoName}-worktrees`, `wt-${worktreeId}`);
}

export function normalizeClaudeSandboxPath(authPath: string): string {
  return authPath;
}

export function healWorktreeConfig(authPath: string, worktreePath: string): void {
  // Ensure .agentteams/ symlink exists
  const sourceAgentteams = path.join(authPath, '.agentteams');
  const targetAgentteams = path.join(worktreePath, '.agentteams');
  if (existsSync(sourceAgentteams) && !existsSync(targetAgentteams)) {
    try {
      // Windows directory junctions do not require Developer Mode or elevation.
      symlinkSync(sourceAgentteams, targetAgentteams, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Non-critical: agent can still work without conventions
    }
  }

  // Claude Code runner uses --dangerously-skip-permissions, so no sandbox
  // or permission settings are needed in settings.local.json.
}

export function createWorktree(
  authPath: string,
  options: {
    worktreeId: string;
    baseBranch?: string | null;
  },
): string {
  const { worktreeId, baseBranch } = options;
  const worktreePath = resolveWorktreePath(authPath, worktreeId);
  const branchName = `worktree/${worktreeId}`;

  if (!isGitRepo(authPath)) {
    throw new Error(`Not a git repository: ${authPath}`);
  }

  // Reuse existing worktree (continue trigger case)
  if (existsSync(worktreePath) && isGitRepo(worktreePath)) {
    healWorktreeConfig(authPath, worktreePath);
    return worktreePath;
  }

  const parentDir = path.dirname(worktreePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    const args = ['worktree', 'add', '-b', branchName, worktreePath];
    if (baseBranch) {
      const baseCommit = resolveBaseCommit(authPath, baseBranch);
      if (!baseCommit) throw new Error(`Invalid base reference: ${baseBranch}`);
      args.push(baseCommit);
    }
    runGit(args, authPath);
  } catch (error) {
    throw new Error(
      `Failed to create git worktree for worktreeId ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  healWorktreeConfig(authPath, worktreePath);

  // Copy gitignored .env* files (root + workspace subdirs)
  // Uses copy instead of symlink to avoid Prisma symlink resolution issues
  try {
    const copyEnvFiles = (dir: string, prefix: string = '') => {
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.startsWith('.env')) continue;
          const relPath = prefix ? path.join(prefix, entry) : entry;
          const absPath = path.join(authPath, relPath);
          const wtPath = path.join(worktreePath, relPath);
          // Git-tracked files (e.g. .env.example) already exist in worktree — skip them
          if (existsSync(absPath) && !existsSync(wtPath)) {
            copyFileSync(absPath, wtPath);
          }
        }
      } catch {
        /* ignore read errors */
      }
    };

    // Root level
    copyEnvFiles(authPath);

    // First-level subdirectories (workspace level)
    for (const entry of readdirSync(authPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        copyEnvFiles(path.join(authPath, entry.name), entry.name);
      }
    }
  } catch {
    // Non-critical: worktree can still work without env files
  }

  return worktreePath;
}

export function removeWorktree(authPath: string, worktreePath: string, worktreeId: string): void {
  const branchName = `worktree/${worktreeId}`;

  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree path does not exist: ${worktreePath}`);
  }

  try {
    runGit(['worktree', 'remove', worktreePath, '--force'], authPath);
  } catch {
    // If worktree removal via git fails, try to clean up manually
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    try {
      runGit(['worktree', 'prune'], authPath);
    } catch {
      // Ignore prune errors
    }
  }

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree directory still exists after removal: ${worktreePath}`);
  }

  try {
    runGit(['branch', '-D', branchName], authPath);
  } catch {
    // Branch may not exist or already deleted; ignore
  }

  try {
    runGit(['ls-remote', '--exit-code', 'origin', `refs/heads/${branchName}`], authPath);
    runGit(['push', 'origin', '--delete', branchName], authPath);
  } catch {
    // Remote branch may not exist or deletion may fail; ignore
  }
}
