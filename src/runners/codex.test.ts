import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexExecArgs, resolveCodexSandboxLevel } from "./codex.js";

test("resolveCodexSandboxLevel defaults to workspace-write", () => {
  assert.equal(resolveCodexSandboxLevel(undefined), "workspace-write");
  assert.equal(resolveCodexSandboxLevel(""), "workspace-write");
  assert.equal(resolveCodexSandboxLevel("danger-full-access"), "workspace-write");
});

test("resolveCodexSandboxLevel accepts off", () => {
  assert.equal(resolveCodexSandboxLevel("off"), "off");
});

test("buildCodexExecArgs keeps sandboxing by default", () => {
  assert.deepEqual(buildCodexExecArgs("hello", "gpt-5-codex", "workspace-write"), [
    "-a",
    "never",
    "exec",
    "-s",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--model",
    "gpt-5-codex",
    "hello"
  ]);
});

test("buildCodexExecArgs disables sandbox when requested", () => {
  assert.deepEqual(buildCodexExecArgs("hello", null, "off"), [
    "-a",
    "never",
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello"
  ]);
});

test("resolveCodexSandboxLevel reads from process.env when no argument given", () => {
  const original = process.env.CODEX_SANDBOX_LEVEL;
  try {
    process.env.CODEX_SANDBOX_LEVEL = "off";
    assert.equal(resolveCodexSandboxLevel(), "off");

    process.env.CODEX_SANDBOX_LEVEL = "workspace-write";
    assert.equal(resolveCodexSandboxLevel(), "workspace-write");

    delete process.env.CODEX_SANDBOX_LEVEL;
    assert.equal(resolveCodexSandboxLevel(), "workspace-write");
  } finally {
    if (original !== undefined) {
      process.env.CODEX_SANDBOX_LEVEL = original;
    } else {
      delete process.env.CODEX_SANDBOX_LEVEL;
    }
  }
});
