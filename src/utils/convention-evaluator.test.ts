import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConventionMeta } from "../types.js";

const withGitRepo = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "conv-eval-"));
  execFileSync("git", ["init", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "initial"], { stdio: "pipe" });

  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("evaluateConventionTriggers", () => {
  it("returns empty array for empty conventions", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");
    const result = evaluateConventionTriggers([], { authPath: "/tmp", planType: null });
    assert.deepEqual(result, []);
  });

  it("matches task trigger when planType matches", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");
    const taskConvention: ConventionMeta = {
      id: "conv-task",
      filePath: ".agentteams/rules/testing.md",
      trigger: "task:BUG_FIX",
      title: "Bug Fix Convention",
      description: "Rules for bug fixes",
    };

    const result = evaluateConventionTriggers([taskConvention], {
      authPath: "/tmp/nonexistent",
      planType: "BUG_FIX",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "conv-task");
  });

  it("does not match task trigger when planType differs", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");
    const taskConvention: ConventionMeta = {
      id: "conv-task",
      filePath: ".agentteams/rules/testing.md",
      trigger: "task:BUG_FIX",
      title: "Bug Fix Convention",
      description: null,
    };

    const result = evaluateConventionTriggers([taskConvention], {
      authPath: "/tmp/nonexistent",
      planType: "FEATURE",
    });

    assert.equal(result.length, 0);
  });

  it("does not match task trigger when planType is null", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");
    const taskConvention: ConventionMeta = {
      id: "conv-task",
      filePath: ".agentteams/rules/testing.md",
      trigger: "task:FEATURE",
      title: "Feature Convention",
      description: null,
    };

    const result = evaluateConventionTriggers([taskConvention], {
      authPath: "/tmp/nonexistent",
      planType: null,
    });

    assert.equal(result.length, 0);
  });

  it("skips conventions with null trigger", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");
    const nullTriggerConvention: ConventionMeta = {
      id: "conv-null",
      filePath: ".agentteams/rules/misc.md",
      trigger: null,
      title: "Misc Convention",
      description: null,
    };

    const result = evaluateConventionTriggers([nullTriggerConvention], {
      authPath: "/tmp/nonexistent",
      planType: "BUG_FIX",
    });

    assert.equal(result.length, 0);
  });

  it("matches composite trigger via task type", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");
    const compositeConvention: ConventionMeta = {
      id: "conv-composite",
      filePath: ".agentteams/rules/frontend.md",
      trigger: "file:web/src/**|task:FEATURE",
      title: "Frontend Convention",
      description: null,
    };

    const result = evaluateConventionTriggers([compositeConvention], {
      authPath: "/tmp/nonexistent",
      planType: "FEATURE",
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "conv-composite");
  });

  it("matches file trigger when a changed file matches the glob", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");

    await withGitRepo(async (dir) => {
      await mkdir(join(dir, "api/prisma"), { recursive: true });
      await writeFile(join(dir, "api/prisma/schema.prisma"), "model Test {}\n");

      const result = evaluateConventionTriggers([{
        id: "conv-file",
        filePath: ".agentteams/rules/schema.md",
        trigger: "file:api/prisma/**",
        title: "Schema Convention",
        description: null,
      }], {
        authPath: dir,
        planType: null,
      });

      assert.deepEqual(result.map((item) => item.id), ["conv-file"]);
    });
  });

  it("does not match file trigger when changed files fall outside the glob", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");

    await withGitRepo(async (dir) => {
      await mkdir(join(dir, "web/src"), { recursive: true });
      await writeFile(join(dir, "web/src/app.tsx"), "export default function App() { return null; }\n");

      const result = evaluateConventionTriggers([{
        id: "conv-file",
        filePath: ".agentteams/rules/schema.md",
        trigger: "file:api/prisma/**",
        title: "Schema Convention",
        description: null,
      }], {
        authPath: dir,
        planType: null,
      });

      assert.equal(result.length, 0);
    });
  });

  it("matches when any file pattern in a multi-file trigger matches", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");

    await withGitRepo(async (dir) => {
      await mkdir(join(dir, "web/src"), { recursive: true });
      await writeFile(join(dir, "web/src/page.tsx"), "export default function Page() { return null; }\n");

      const result = evaluateConventionTriggers([{
        id: "conv-multi-file",
        filePath: ".agentteams/rules/frontend.md",
        trigger: "file:api/**|file:web/**",
        title: "Frontend Convention",
        description: null,
      }], {
        authPath: dir,
        planType: "BUG_FIX",
      });

      assert.deepEqual(result.map((item) => item.id), ["conv-multi-file"]);
    });
  });

  it("matches composite trigger via file condition when task type does not match", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");

    await withGitRepo(async (dir) => {
      await mkdir(join(dir, "api/src"), { recursive: true });
      await writeFile(join(dir, "api/src/server.ts"), "export const server = true;\n");

      const result = evaluateConventionTriggers([{
        id: "conv-composite-file",
        filePath: ".agentteams/rules/routes.md",
        trigger: "file:api/**|task:FEATURE",
        title: "Route Convention",
        description: null,
      }], {
        authPath: dir,
        planType: "BUG_FIX",
      });

      assert.deepEqual(result.map((item) => item.id), ["conv-composite-file"]);
    });
  });

  it("returns no matches when git diff lookup fails", async () => {
    const { evaluateConventionTriggers } = await import("./convention-evaluator.js");

    const result = evaluateConventionTriggers([{
      id: "conv-file",
      filePath: ".agentteams/rules/schema.md",
      trigger: "file:api/**",
      title: "Schema Convention",
      description: null,
    }], {
      authPath: "/tmp/does-not-exist-for-convention-evaluator",
      planType: null,
    });

    assert.equal(result.length, 0);
  });
});
