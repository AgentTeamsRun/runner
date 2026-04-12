import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConventionMeta } from "../types.js";

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
});
