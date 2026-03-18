import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

export function normalizeClaudeSandboxPath(authPath: string): string {
  return authPath;
}

export function healWorktreeConfig(authPath: string, worktreePath: string): void {
  // Ensure .agentteams/ symlink exists
  const sourceAgentteams = path.join(authPath, ".agentteams");
  const targetAgentteams = path.join(worktreePath, ".agentteams");
  if (existsSync(sourceAgentteams) && !existsSync(targetAgentteams)) {
    try {
      symlinkSync(sourceAgentteams, targetAgentteams, "dir");
    } catch {
      // Non-critical: agent can still work without conventions
    }
  }

  // Ensure Claude Code sandbox allows access to the original repo
  try {
    const claudeSettingsDir = path.join(worktreePath, ".claude");
    const claudeSettingsPath = path.join(claudeSettingsDir, "settings.local.json");
    if (!existsSync(claudeSettingsDir)) {
      mkdirSync(claudeSettingsDir, { recursive: true });
    }
    const existing = existsSync(claudeSettingsPath)
      ? JSON.parse(readFileSync(claudeSettingsPath, "utf8"))
      : {};
    const correctPath = normalizeClaudeSandboxPath(authPath);
    const permissions = existing.permissions ?? {};
    const additionalDirectories: string[] = permissions.additionalDirectories ?? [];

    // Remove malformed entries (e.g. ///Users/... from previous bug)
    const cleanedDirs = additionalDirectories.filter((p: string) => p === correctPath || !p.endsWith(authPath));
    if (!cleanedDirs.includes(correctPath)) {
      cleanedDirs.push(correctPath);
    }
    existing.permissions = { ...permissions, additionalDirectories: cleanedDirs };
    // Clean up legacy top-level additionalDirectories if present
    delete existing.additionalDirectories;
    writeFileSync(claudeSettingsPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  } catch {
    // Non-critical: sandbox config failure won't block runner
  }
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
    healWorktreeConfig(authPath, worktreePath);
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

  healWorktreeConfig(authPath, worktreePath);

  // Symlink gitignored .env* files (root + workspace subdirs)
  try {
    const symlinkEnvFiles = (dir: string, prefix: string = "") => {
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.startsWith(".env")) continue;
          const relPath = prefix ? path.join(prefix, entry) : entry;
          const absPath = path.join(authPath, relPath);
          const wtPath = path.join(worktreePath, relPath);
          // Git-tracked files (e.g. .env.example) already exist in worktree — skip them
          if (existsSync(absPath) && !existsSync(wtPath)) {
            symlinkSync(absPath, wtPath);
          }
        }
      } catch { /* ignore read errors */ }
    };

    // Root level
    symlinkEnvFiles(authPath);

    // First-level subdirectories (workspace level)
    for (const entry of readdirSync(authPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        symlinkEnvFiles(path.join(authPath, entry.name), entry.name);
      }
    }
  } catch {
    // Non-critical: worktree can still work without env files
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

  try {
    execFileSync("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branchName}`], {
      cwd: authPath,
      stdio: "pipe"
    });
    execFileSync("git", ["push", "origin", "--delete", branchName], {
      cwd: authPath,
      stdio: "pipe"
    });
  } catch {
    // Remote branch may not exist or deletion may fail; ignore
  }
}
