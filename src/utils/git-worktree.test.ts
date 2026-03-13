import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { isGitRepo, createWorktree, removeWorktree, resolveWorktreePath } from "./git-worktree.js";

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
  const authPath = "/home/user/projects/my-repo";
  const worktreeId = "abc123";
  const expected = "/home/user/projects/.my-repo-worktrees/wt-abc123";
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
    // Create a branch to use as base
    execFileSync("git", ["-C", repo, "checkout", "-b", "feature-branch"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "feature commit"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "checkout", "master"], { stdio: "pipe" }).toString().trim();

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

test("removeWorktree handles already-removed worktree gracefully", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-already-gone";
  try {
    const worktreePath = resolveWorktreePath(repo, worktreeId);
    // Should not throw even if worktree never existed
    removeWorktree(repo, worktreePath, worktreeId);
  } finally {
    cleanupDir(repo);
  }
});
