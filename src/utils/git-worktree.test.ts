import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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

test("createWorktree symlinks root .env files", () => {
  const repo = makeTempGitRepo();
  const worktreeId = "test-wt-env-root";
  try {
    // Create .env and .env.local in the repo root
    writeFileSync(join(repo, ".env"), "ROOT_KEY=value");
    writeFileSync(join(repo, ".env.local"), "LOCAL_KEY=value");

    const worktreePath = createWorktree(repo, { worktreeId });

    const envLink = join(worktreePath, ".env");
    const envLocalLink = join(worktreePath, ".env.local");

    assert.equal(existsSync(envLink), true);
    assert.equal(lstatSync(envLink).isSymbolicLink(), true);
    assert.equal(readlinkSync(envLink), join(repo, ".env"));

    assert.equal(existsSync(envLocalLink), true);
    assert.equal(lstatSync(envLocalLink).isSymbolicLink(), true);
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
  }
});

test("createWorktree symlinks workspace-level .env files", () => {
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

    const apiEnvLink = join(worktreePath, "api", ".env");
    const webEnvLink = join(worktreePath, "web", ".env");

    assert.equal(existsSync(apiEnvLink), true);
    assert.equal(lstatSync(apiEnvLink).isSymbolicLink(), true);
    assert.equal(readlinkSync(apiEnvLink), join(repo, "api", ".env"));

    assert.equal(existsSync(webEnvLink), true);
    assert.equal(lstatSync(webEnvLink).isSymbolicLink(), true);
    assert.equal(readlinkSync(webEnvLink), join(repo, "web", ".env"));
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

    // Also create .env (gitignored — should be symlinked)
    writeFileSync(join(repo, ".env"), "SECRET=value");

    const worktreePath = createWorktree(repo, { worktreeId });

    // .env.example should NOT be a symlink (it's a regular file from git)
    const exampleFile = join(worktreePath, ".env.example");
    assert.equal(existsSync(exampleFile), true);
    assert.equal(lstatSync(exampleFile).isSymbolicLink(), false);

    // .env should be a symlink
    const envLink = join(worktreePath, ".env");
    assert.equal(existsSync(envLink), true);
    assert.equal(lstatSync(envLink).isSymbolicLink(), true);
  } finally {
    cleanupDir(repo);
    const repoName = basename(repo);
    cleanupDir(join(dirname(repo), `.${repoName}-worktrees`));
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
