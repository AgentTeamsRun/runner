import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeHook, executePreHooks } from "./hook-executor.js";
import type { HookContext } from "./hook-executor.js";
import type { HookDefinition } from "./types.js";

const makeContext = (overrides?: Partial<HookContext>): HookContext => ({
  authPath: process.cwd(),
  triggerId: "test-trigger-id",
  triggerLogAppend: () => {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// executeHook
// ---------------------------------------------------------------------------

describe("executeHook", () => {
  it("returns success=true when command exits 0", async () => {
    const hook: HookDefinition = { name: "echo-hook", command: "echo hello", onFailure: "fail" };
    const result = await executeHook(hook, makeContext());

    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.name, "echo-hook");
    assert.ok(result.stdout.includes("hello"));
    assert.ok(result.durationMs >= 0);
  });

  it("returns success=false when command exits non-zero", async () => {
    const hook: HookDefinition = { name: "fail-hook", command: "exit 1", onFailure: "fail" };
    const result = await executeHook(hook, makeContext());

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
  });

  it("captures stderr", async () => {
    const hook: HookDefinition = { name: "stderr-hook", command: "echo error >&2", onFailure: "fail" };
    const result = await executeHook(hook, makeContext());

    assert.ok(result.stderr.includes("error"));
  });

  it("kills process on timeout and returns success=false", async () => {
    const hook: HookDefinition = { name: "slow-hook", command: "sleep 60", onFailure: "fail" };
    const result = await executeHook(hook, makeContext(), 200);

    assert.equal(result.success, false);
    assert.equal(result.exitCode, null);
    assert.ok(result.stderr.includes("timed out"));
    assert.ok(result.durationMs < 5000);
  });

  it("uses authPath as cwd", async () => {
    const hook: HookDefinition = { name: "pwd-hook", command: "pwd", onFailure: "fail" };
    const ctx = makeContext({ authPath: "/tmp" });
    const result = await executeHook(hook, ctx);

    assert.equal(result.success, true);
    // /tmp may resolve to /private/tmp on macOS
    assert.ok(
      result.stdout.trim() === "/tmp" || result.stdout.trim() === "/private/tmp",
      `Expected /tmp or /private/tmp but got ${result.stdout.trim()}`
    );
  });
});

// ---------------------------------------------------------------------------
// executePreHooks
// ---------------------------------------------------------------------------

describe("executePreHooks", () => {
  it("returns empty results for no hooks", async () => {
    const outcome = await executePreHooks([], makeContext());

    assert.deepStrictEqual(outcome.results, []);
    assert.equal(outcome.failureAction, null);
    assert.equal(outcome.failureReason, null);
  });

  it("runs all hooks sequentially when all pass", async () => {
    const hooks: HookDefinition[] = [
      { name: "h1", command: "echo one", onFailure: "fail" },
      { name: "h2", command: "echo two", onFailure: "fail" },
    ];
    const outcome = await executePreHooks(hooks, makeContext());

    assert.equal(outcome.results.length, 2);
    assert.ok(outcome.results.every((r) => r.success));
    assert.equal(outcome.failureAction, null);
  });

  it("stops on first failure with onFailure=fail", async () => {
    const hooks: HookDefinition[] = [
      { name: "pass", command: "echo ok", onFailure: "fail" },
      { name: "blocker", command: "exit 1", onFailure: "fail" },
      { name: "never", command: "echo unreachable", onFailure: "fail" },
    ];
    const outcome = await executePreHooks(hooks, makeContext());

    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.failureAction, "fail");
    assert.ok(outcome.failureReason!.includes("blocker"));
  });

  it("continues on failure with onFailure=warn", async () => {
    const hooks: HookDefinition[] = [
      { name: "warn-hook", command: "exit 1", onFailure: "warn" },
      { name: "after", command: "echo ok", onFailure: "fail" },
    ];
    const outcome = await executePreHooks(hooks, makeContext());

    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.failureAction, null);
    assert.equal(outcome.results[0].success, false);
    assert.equal(outcome.results[1].success, true);
  });

  it("returns needs_review as failureAction", async () => {
    const hooks: HookDefinition[] = [
      { name: "review-hook", command: "exit 2", onFailure: "needs_review" },
    ];
    const outcome = await executePreHooks(hooks, makeContext());

    assert.equal(outcome.failureAction, "needs_review");
    assert.ok(outcome.failureReason!.includes("needs_review"));
  });

  it("logs hook output via triggerLogAppend", async () => {
    const logs: string[] = [];
    const ctx = makeContext({
      triggerLogAppend: (_level, msg) => logs.push(msg),
    });

    const hooks: HookDefinition[] = [
      { name: "log-hook", command: "echo logged", onFailure: "fail" },
    ];
    await executePreHooks(hooks, ctx);

    assert.ok(logs.some((l) => l.includes("log-hook")));
    assert.ok(logs.some((l) => l.includes("logged")));
  });
});
