import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { mergeHarnessConfig, loadLocalHarnessConfig } from "./config-loader.js";
import type { HarnessYml } from "./types.js";

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "harness-config-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// mergeHarnessConfig
// ---------------------------------------------------------------------------

describe("mergeHarnessConfig", () => {
  test("returns empty config when both are null", () => {
    const result = mergeHarnessConfig(null, null);
    assert.deepStrictEqual(result, {
      preHooks: [],
      postHooks: [],
      qualityGate: null,
      conventionIds: []
    });
  });

  test("returns server config when local is null", () => {
    const server: HarnessYml = {
      preHooks: [{ name: "lint", command: "npm run lint", onFailure: "fail" }],
      postHooks: [],
      qualityGate: { minScore: 80, onBelowThreshold: "warn" },
      conventionIds: ["conv-1"]
    };

    const result = mergeHarnessConfig(null, server);
    assert.deepStrictEqual(result.preHooks, server.preHooks);
    assert.deepStrictEqual(result.qualityGate, server.qualityGate);
    assert.deepStrictEqual(result.conventionIds, ["conv-1"]);
  });

  test("returns local config when server is null", () => {
    const local: HarnessYml = {
      preHooks: [{ name: "test", command: "npm test", onFailure: "needs_review" }]
    };

    const result = mergeHarnessConfig(local, null);
    assert.deepStrictEqual(result.preHooks, local.preHooks);
    assert.deepStrictEqual(result.postHooks, []);
    assert.strictEqual(result.qualityGate, null);
    assert.deepStrictEqual(result.conventionIds, []);
  });

  test("local overrides server at field level", () => {
    const local: HarnessYml = {
      preHooks: [{ name: "local-lint", command: "eslint .", onFailure: "warn" }]
    };

    const server: HarnessYml = {
      preHooks: [{ name: "server-lint", command: "npm run lint", onFailure: "fail" }],
      postHooks: [{ name: "deploy", command: "npm run deploy", onFailure: "fail" }],
      qualityGate: { minScore: 90, onBelowThreshold: "fail" }
    };

    const result = mergeHarnessConfig(local, server);
    // local preHooks overrides server
    assert.strictEqual(result.preHooks.length, 1);
    assert.strictEqual(result.preHooks[0]!.name, "local-lint");
    // server postHooks used (local didn't specify)
    assert.strictEqual(result.postHooks.length, 1);
    assert.strictEqual(result.postHooks[0]!.name, "deploy");
    // server qualityGate used (local didn't specify)
    assert.strictEqual(result.qualityGate?.minScore, 90);
  });

  test("local can explicitly set qualityGate to null", () => {
    const local: HarnessYml = { qualityGate: null };
    const server: HarnessYml = {
      qualityGate: { minScore: 80, onBelowThreshold: "fail" }
    };

    const result = mergeHarnessConfig(local, server);
    assert.strictEqual(result.qualityGate, null);
  });

  test("local conventionIds overrides server conventionIds", () => {
    const local: HarnessYml = {
      conventionIds: ["local-conv-1", "local-conv-2"]
    };
    const server: HarnessYml = {
      conventionIds: ["server-conv-1"]
    };

    const result = mergeHarnessConfig(local, server);
    assert.deepStrictEqual(result.conventionIds, ["local-conv-1", "local-conv-2"]);
  });

  test("falls back to server conventionIds when local omits it", () => {
    const local: HarnessYml = {
      preHooks: [{ name: "test", command: "npm test", onFailure: "warn" }]
    };
    const server: HarnessYml = {
      conventionIds: ["server-conv-1"]
    };

    const result = mergeHarnessConfig(local, server);
    assert.deepStrictEqual(result.conventionIds, ["server-conv-1"]);
  });
});

// ---------------------------------------------------------------------------
// loadLocalHarnessConfig
// ---------------------------------------------------------------------------

describe("loadLocalHarnessConfig", () => {
  test("returns null when harness.yml does not exist", async () => {
    await withTempDir(async (dir) => {
      const result = await loadLocalHarnessConfig(dir);
      assert.strictEqual(result, null);
    });
  });

  test("parses harness.yml with pre-hooks", async () => {
    await withTempDir(async (dir) => {
      const agentteamsDir = join(dir, ".agentteams");
      await mkdir(agentteamsDir, { recursive: true });
      await writeFile(
        join(agentteamsDir, "harness.yml"),
        [
          "preHooks:",
          "  - name: lint",
          "    command: npm run lint",
          "    onFailure: fail",
          "postHooks:",
          "  - name: report",
          "    command: npm run report",
          "    onFailure: warn"
        ].join("\n"),
        "utf8"
      );

      const result = await loadLocalHarnessConfig(dir);
      assert.ok(result);
      assert.strictEqual(result.preHooks?.length, 1);
      assert.strictEqual(result.preHooks![0]!.name, "lint");
      assert.strictEqual(result.preHooks![0]!.command, "npm run lint");
      assert.strictEqual(result.preHooks![0]!.onFailure, "fail");
      assert.strictEqual(result.postHooks?.length, 1);
      assert.strictEqual(result.postHooks![0]!.name, "report");
    });
  });
});
