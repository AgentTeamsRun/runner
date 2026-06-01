import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexExecArgs, resolveCodexSandboxLevel, toPowerShellEncodedCommand } from "./codex.js";

const decodeEncodedCommand = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf16le");

test("resolveCodexSandboxLevel defaults to workspace-write", () => {
  const original = process.env.CODEX_SANDBOX_LEVEL;
  try {
    delete process.env.CODEX_SANDBOX_LEVEL;
    assert.equal(resolveCodexSandboxLevel(undefined), "workspace-write");
    assert.equal(resolveCodexSandboxLevel(""), "workspace-write");
    assert.equal(resolveCodexSandboxLevel("danger-full-access"), "workspace-write");
  } finally {
    if (original !== undefined) {
      process.env.CODEX_SANDBOX_LEVEL = original;
    } else {
      delete process.env.CODEX_SANDBOX_LEVEL;
    }
  }
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

test("buildCodexExecArgs enables fast mode with service tier config", () => {
  assert.deepEqual(buildCodexExecArgs("hello", "gpt-5.5", "workspace-write", true), [
    "-a",
    "never",
    "exec",
    "-s",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "features.fast_mode=true",
    "-c",
    "service_tier=\"fast\"",
    "--model",
    "gpt-5.5",
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

test("toPowerShellEncodedCommand reads prompt from file instead of embedding it", () => {
  const promptFilePath = "C:\\repo\\.agentteams\\runner\\tmp\\trigger-123.prompt.txt";
  const encoded = toPowerShellEncodedCommand(
    "C:\\Users\\dev\\codex.cmd",
    promptFilePath,
    "gpt-5-codex",
    "workspace-write"
  );
  const decoded = decodeEncodedCommand(encoded);

  // prompt 파일을 UTF-8(no BOM)로 명시적으로 읽어야 한다.
  assert.ok(decoded.includes("[System.IO.File]::ReadAllText"));
  assert.ok(decoded.includes("$utf8NoBom"));
  // encoded command 에는 prompt 본문이 아니라 파일 경로만 포함된다.
  assert.ok(decoded.includes(promptFilePath));
});

test("toPowerShellEncodedCommand length does not scale with prompt length", () => {
  const promptFilePath = "C:\\repo\\.agentteams\\runner\\tmp\\trigger-456.prompt.txt";
  // prompt 본문은 인자가 아니므로, 아무리 길어도 encoded command 크기에 영향을 주지 않는다.
  const encodedShort = toPowerShellEncodedCommand("C:\\codex.cmd", promptFilePath, "gpt-5-codex", "workspace-write");
  const encodedSame = toPowerShellEncodedCommand("C:\\codex.cmd", promptFilePath, "gpt-5-codex", "workspace-write");

  assert.equal(encodedShort, encodedSame);
  // 1MB 이상의 한글 prompt를 가정해도 encoded command 는 고정 스크립트 크기(2KB 미만)로 유지된다.
  assert.ok(encodedShort.length < 2048);
});

test("toPowerShellEncodedCommand preserves model, sandbox, and fast mode args", () => {
  const encoded = toPowerShellEncodedCommand(
    "C:\\codex.cmd",
    "C:\\repo\\.agentteams\\runner\\tmp\\t.prompt.txt",
    "gpt-5.5",
    "workspace-write",
    true
  );
  const decoded = decodeEncodedCommand(encoded);

  assert.ok(decoded.includes("'--model' 'gpt-5.5'"));
  assert.ok(decoded.includes("'-s' 'workspace-write'"));
  assert.ok(decoded.includes("'-c' 'sandbox_workspace_write.network_access=true'"));
  assert.ok(decoded.includes("features.fast_mode=true"));
  assert.ok(decoded.includes("service_tier=\"fast\""));
});

test("toPowerShellEncodedCommand uses bypass flag and omits model when sandbox off", () => {
  const encoded = toPowerShellEncodedCommand(
    "C:\\codex.cmd",
    "C:\\repo\\.agentteams\\runner\\tmp\\t.prompt.txt",
    null,
    "off"
  );
  const decoded = decodeEncodedCommand(encoded);

  assert.ok(decoded.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!decoded.includes("'--model'"));
  assert.ok(!decoded.includes("features.fast_mode=true"));
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
