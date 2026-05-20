import assert from "node:assert/strict";
import test from "node:test";
import { buildAntigravityExecArgs } from "./antigravity.js";

test("buildAntigravityExecArgs uses verified print-mode contract", () => {
  assert.deepEqual(buildAntigravityExecArgs("hello", 20_000), [
    "--dangerously-skip-permissions",
    "--add-dir",
    ".agentteams",
    "--print-timeout",
    "20s",
    "--print",
    "hello"
  ]);
});

test("buildAntigravityExecArgs defaults print timeout to runner fail-safe window", () => {
  assert.deepEqual(buildAntigravityExecArgs("hello"), [
    "--dangerously-skip-permissions",
    "--add-dir",
    ".agentteams",
    "--print-timeout",
    "86400s",
    "--print",
    "hello"
  ]);
});
