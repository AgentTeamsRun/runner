import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export function isGitRepo(dirPath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dirPath,
      stdio: "pipe"
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveWorktreePath(authPath: string, worktreeId: string): string {
  const repoName = path.basename(authPath);
  return path.join(path.dirname(authPath), `.${repoName}-worktrees`, `wt-${worktreeId}`);
}

export function createWorktree(authPath: string, options: {
  worktreeId: string;
  baseBranch?: string | null;
}): string {
  const { worktreeId, baseBranch } = options;
  const worktreePath = resolveWorktreePath(authPath, worktreeId);
  const branchName = `worktree/${worktreeId}`;

  if (!isGitRepo(authPath)) {
    throw new Error(`Not a git repository: ${authPath}`);
  }

  // Reuse existing worktree (continue trigger case)
  if (existsSync(worktreePath) && isGitRepo(worktreePath)) {
    return worktreePath;
  }

  const parentDir = path.dirname(worktreePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    const args = ["worktree", "add", "-b", branchName, worktreePath];
    if (baseBranch) {
      args.push(baseBranch);
    }
    execFileSync("git", args, { cwd: authPath, stdio: "pipe" });
  } catch (error) {
    throw new Error(
      `Failed to create git worktree for worktreeId ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return worktreePath;
}

export function removeWorktree(authPath: string, worktreePath: string, worktreeId: string): void {
  const branchName = `worktree/${worktreeId}`;

  try {
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
      cwd: authPath,
      stdio: "pipe"
    });
  } catch (error) {
    // If worktree removal via git fails, try to clean up manually
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: authPath, stdio: "pipe" });
    } catch {
      // Ignore prune errors
    }
  }

  try {
    execFileSync("git", ["branch", "-D", branchName], {
      cwd: authPath,
      stdio: "pipe"
    });
  } catch {
    // Branch may not exist or already deleted; ignore
  }
}
