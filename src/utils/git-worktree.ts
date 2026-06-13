import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

// 모든 git 호출은 이 헬퍼를 통해 실행해야 한다. windowsHide 누락 시 Windows에서
// 콘솔 미부착 부모(데몬) 프로세스가 git.exe를 띄울 때 콘솔 창이 잠깐 노출된다.
function runGit(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true });
}

export function isGitRepo(dirPath: string): boolean {
  try {
    runGit(['rev-parse', '--is-inside-work-tree'], dirPath);
    return true;
  } catch {
    return false;
  }
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
      symlinkSync(sourceAgentteams, targetAgentteams, 'dir');
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
      args.push(baseBranch);
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
