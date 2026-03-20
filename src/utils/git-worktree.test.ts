import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { isGitRepo, createWorktree, removeWorktree, resolveWorktreePath, normalizeClaudeSandboxPath, healWorktreeConfig } from "./git-worktree.js";

const makeTempGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "git-worktree-test-"));
  execFileSync("git", ["init", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  // Create an initial commit so HEAD exists
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "initial"], { stdio: "pipe" });
  return dir;
};

const cleanupDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

test("isGitRepo returns true for a git directory", () => {
  const repo = makeTempGitRepo();
  try {
    assert.equal(isGitRepo(repo), true);
  } finally {
    cleanupDir(repo);
  }
});

test("isGitRepo returns false for a non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-worktree-test-nongit-"));
  try {
    assert.equal(isGitRepo(dir), false);
  } finally {
    cleanupDir(dir);
  }
});

test("isGitRepo returns false for a non-existent directory", () => {
  assert.equal(isGitRepo(join(tmpdir(), "nonexistent-dir-" + Date.now())), false);
});

test("resolveWorktreePath returns sibling directory path", () => {
  const authPath = join("home", "user", "projects", "my-repo");
  const worktreeId = "abc123";
  const expected = join("home", "user", "projects", ".my-repo-worktrees", "wt-abc123");
  assert.equal(resolveWorktreePath(authPath, worktreeId), expected);
});

test("createWorktree creates worktree at expected path", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-001";
  try {
    const worktreePath = createWorktree(repo, { worktreeId });
    const repoName = basename(repo);
    const expectedPath = join(dirname(repo), `.${repoName}-worktrees`, `wt-${worktreeId}`);

    assert.equal(worktreePath, expectedPath);
    assert.equal(existsSync(worktreePath), true);
    assert.equal(isGitRepo(worktreePath), true);

    // Verify branch was created
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", `worktree/${worktreeId}`], {
      stdio: "pipe",
      encoding: "utf8"
    }).trim();
    assert.ok(branches.includes(`worktree/${worktreeId}`));
  } finally {
    cleanupDir(repo);
    // Clean up sibling worktree directory
    const repoName = basename(repo);
    const worktreeDir = join(dirname(repo), `.${repoName}-worktrees`);
    cleanupDir(worktreeDir);
  }
});

test("createWorktree creates worktree from specified baseBranch", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-branch";
  try {
    const initialBranch = execFileSync("git", ["-C", repo, "branch", "--show-current"], {
      stdio: "pipe",
      encoding: "utf8"
    }).trim();

    // Create a branch to use as base
    execFileSync("git", ["-C", repo, "checkout", "-b", "feature-branch"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "feature commit"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "checkout", initialBranch], { stdio: "pipe" });

    const worktreePath = createWorktree(repo, {
      worktreeId,
      baseBranch: "feature-branch"
    });

    assert.equal(existsSync(worktreePath), true);
    assert.equal(isGitRepo(worktreePath), true);
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("createWorktree reuses existing worktree", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-reuse";
  try {
    const firstPath = createWorktree(repo, { worktreeId });
    assert.equal(existsSync(firstPath), true);

    // Second call should reuse existing worktree
    const secondPath = createWorktree(repo, { worktreeId });
    assert.equal(secondPath, firstPath);
    assert.equal(existsSync(secondPath), true);
    assert.equal(isGitRepo(secondPath), true);
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("removeWorktree cleans up worktree and branch", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-remove";
  try {
    const worktreePath = createWorktree(repo, { worktreeId });
    assert.equal(existsSync(worktreePath), true);

    removeWorktree(repo, worktreePath, worktreeId);

    assert.equal(existsSync(worktreePath), false);

    // Verify branch was deleted
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", `worktree/${worktreeId}`], {
      stdio: "pipe",
      encoding: "utf8"
    }).trim();
    assert.equal(branches, "");
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("createWorktree symlinks .agentteams from original repo", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-symlink";
  try {
    // Create .agentteams/ in the original repo
    const agentteamsDir = join(repo, ".agentteams");
    mkdirSync(agentteamsDir, { recursive: true });

    const worktreePath = createWorktree(repo, { worktreeId });
    const targetLink = join(worktreePath, ".agentteams");

    assert.equal(existsSync(targetLink), true);
    assert.equal(lstatSync(targetLink).isSymbolicLink(), true);
    assert.equal(readlinkSync(targetLink), agentteamsDir);
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("createWorktree throws for invalid (non-git) path", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-worktree-test-invalid-"));
  try {
    assert.throws(
      () => createWorktree(dir, { worktreeId: "invalid-test" }),
      (err: Error) => {
        assert.ok(err.message.includes("Not a git repository"));
        return true;
      }
    );
  } finally {
    cleanupDir(dir);
  }
});

test("createWorktree copies root .env files", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-env-root";
  try {
    // Create .env and .env.local in the repo root
    writeFileSync(join(repo, ".env"), "ROOT_KEY=value");
    writeFileSync(join(repo, ".env.local"), "LOCAL_KEY=value");

    const worktreePath = createWorktree(repo, { worktreeId });

    const envFile = join(worktreePath, ".env");
    const envLocalFile = join(worktreePath, ".env.local");

    assert.equal(existsSync(envFile), true);
    assert.equal(lstatSync(envFile).isSymbolicLink(), false, ".env should be a copy, not a symlink");
    assert.equal(readFileSync(envFile, "utf8"), "ROOT_KEY=value");

    assert.equal(existsSync(envLocalFile), true);
    assert.equal(lstatSync(envLocalFile).isSymbolicLink(), false, ".env.local should be a copy, not a symlink");
    assert.equal(readFileSync(envLocalFile, "utf8"), "LOCAL_KEY=value");
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("createWorktree copies workspace-level .env files", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-env-ws";
  try {
    // Add .gitignore to ignore .env files (like a real project)
    writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\n");

    // Create workspace dirs with a tracked file so dirs exist in worktree
    mkdirSync(join(repo, "api"));
    mkdirSync(join(repo, "web"));
    writeFileSync(join(repo, "api", "index.ts"), "// api");
    writeFileSync(join(repo, "web", "index.ts"), "// web");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add workspace dirs"], { stdio: "pipe" });

    // Create .env files AFTER commit (gitignored, won't be in worktree)
    writeFileSync(join(repo, "api", ".env"), "DB_URL=postgres://...");
    writeFileSync(join(repo, "web", ".env"), "NEXT_PUBLIC_API=http://...");

    const worktreePath = createWorktree(repo, { worktreeId });

    const apiEnvFile = join(worktreePath, "api", ".env");
    const webEnvFile = join(worktreePath, "web", ".env");

    assert.equal(existsSync(apiEnvFile), true);
    assert.equal(lstatSync(apiEnvFile).isSymbolicLink(), false, "api/.env should be a copy, not a symlink");
    assert.equal(readFileSync(apiEnvFile, "utf8"), "DB_URL=postgres://...");

    assert.equal(existsSync(webEnvFile), true);
    assert.equal(lstatSync(webEnvFile).isSymbolicLink(), false, "web/.env should be a copy, not a symlink");
    assert.equal(readFileSync(webEnvFile, "utf8"), "NEXT_PUBLIC_API=http://...");
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("createWorktree skips .env files that already exist in worktree (git-tracked)", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-env-skip";
  try {
    // Create and commit .env.example (git-tracked — will exist in worktree)
    writeFileSync(join(repo, ".env.example"), "EXAMPLE=true");
    execFileSync("git", ["-C", repo, "add", ".env.example"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add env example"], { stdio: "pipe" });

    // Also create .env (gitignored — should be copied)
    writeFileSync(join(repo, ".env"), "SECRET=value");

    const worktreePath = createWorktree(repo, { worktreeId });

    // .env.example should NOT be overwritten (it's a regular file from git)
    const exampleFile = join(worktreePath, ".env.example");
    assert.equal(existsSync(exampleFile), true);
    assert.equal(lstatSync(exampleFile).isSymbolicLink(), false);

    // .env should be a copied file, not a symlink
    const envFile = join(worktreePath, ".env");
    assert.equal(existsSync(envFile), true);
    assert.equal(lstatSync(envFile).isSymbolicLink(), false, ".env should be a copy, not a symlink");
    assert.equal(readFileSync(envFile, "utf8"), "SECRET=value");
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("removeWorktree throws for non-existent worktree path", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-already-gone";
  try {
    const worktreePath = resolveWorktreePath(repo, worktreeId);
    assert.throws(
      () => removeWorktree(repo, worktreePath, worktreeId),
      (err: Error) => {
        assert.ok(err.message.includes("does not exist"));
        return true;
      }
    );
  } finally {
    cleanupDir(repo);
  }
});

test("normalizeClaudeSandboxPath returns absolute path as-is", () => {
  assert.equal(normalizeClaudeSandboxPath("/Users/justin/Project"), "/Users/justin/Project");
  assert.equal(normalizeClaudeSandboxPath("/home/user/repo"), "/home/user/repo");
});

// Claude Code runner uses --dangerously-skip-permissions, so no sandbox
// or permission settings are written to settings.local.json.

test("healWorktreeConfig restores missing .agentteams symlink on reuse", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-heal-symlink";
  try {
    // Create .agentteams/ in the original repo
    mkdirSync(join(repo, ".agentteams"), { recursive: true });

    const worktreePath = createWorktree(repo, { worktreeId });
    const targetLink = join(worktreePath, ".agentteams");

    // Verify symlink was created on first run
    assert.equal(lstatSync(targetLink).isSymbolicLink(), true);

    // Simulate broken state: remove the symlink
    unlinkSync(targetLink);
    assert.equal(existsSync(targetLink), false);

    // Reuse triggers healWorktreeConfig which should restore the symlink
    const reusedPath = createWorktree(repo, { worktreeId });
    assert.equal(reusedPath, worktreePath);
    assert.equal(existsSync(targetLink), true);
    assert.equal(lstatSync(targetLink).isSymbolicLink(), true);
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});
