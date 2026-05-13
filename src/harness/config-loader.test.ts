import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createEmptyHarnessConfig, loadHarnessConfigById } from "./config-loader.js";

describe("createEmptyHarnessConfig", () => {
  test("returns a new empty harness config", () => {
    const first = createEmptyHarnessConfig();
    const second = createEmptyHarnessConfig();

    assert.deepStrictEqual(first, {
      preHooks: [],
      postHooks: [],
      qualityGate: null,
      conventionIds: []
    });
    assert.notStrictEqual(first, second);
  });
});

describe("loadHarnessConfigById", () => {
  test("returns normalized server harness config", async () => {
    const client = {
      fetchHarnessConfigById: async (id: string) => ({
        id,
        config: {
          preHooks: [{ name: "lint", command: "npm run lint", onFailure: "fail" }],
          postHooks: [{ name: "report", command: "npm run report", onFailure: "warn" }],
          qualityGate: { minScore: 80, onBelowThreshold: "needs_review" },
          conventionIds: ["conv-1"]
        }
      })
    };

    const result = await loadHarnessConfigById(client as never, "harness-1");

    assert.equal(result.preHooks.length, 1);
    assert.equal(result.preHooks[0]?.name, "lint");
    assert.equal(result.postHooks.length, 1);
    assert.equal(result.qualityGate?.minScore, 80);
    assert.deepStrictEqual(result.conventionIds, ["conv-1"]);
  });

  test("fills omitted server fields with empty defaults", async () => {
    const client = {
      fetchHarnessConfigById: async () => ({
        config: {
          preHooks: [{ name: "test", command: "npm test", onFailure: "warn" }]
        }
      })
    };

    const result = await loadHarnessConfigById(client as never, "harness-1");

    assert.equal(result.preHooks.length, 1);
    assert.deepStrictEqual(result.postHooks, []);
    assert.strictEqual(result.qualityGate, null);
    assert.deepStrictEqual(result.conventionIds, []);
  });

  test("returns empty config when server harness is missing", async () => {
    const client = {
      fetchHarnessConfigById: async () => null
    };

    const result = await loadHarnessConfigById(client as never, "missing-harness");

    assert.deepStrictEqual(result, createEmptyHarnessConfig());
  });

  test("returns empty config when server lookup fails", async () => {
    const client = {
      fetchHarnessConfigById: async () => {
        throw new Error("network down");
      }
    };

    const result = await loadHarnessConfigById(client as never, "harness-1");

    assert.deepStrictEqual(result, createEmptyHarnessConfig());
  });
});
