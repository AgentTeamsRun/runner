import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAntigravityExecArgs,
  createAntigravityInternalLogForwarder,
  sanitizeAntigravityInternalLogLine,
  toPowerShellEncodedCommand
} from "./antigravity.js";

test("buildAntigravityExecArgs uses verified print-mode contract", () => {
  const cwd = "/tmp/agentteams-project";
  const agentteamsDir = join(cwd, ".agentteams");
  const internalLogPath = join(agentteamsDir, "runner", "log", "trigger.antigravity.log");

  assert.equal(isAbsolute(agentteamsDir), true);
  assert.deepEqual(buildAntigravityExecArgs("hello", agentteamsDir, internalLogPath, 20_000), [
    "--dangerously-skip-permissions",
    "--add-dir",
    agentteamsDir,
    "--log-file",
    internalLogPath,
    "--print-timeout",
    "20s",
    "--print",
    "hello"
  ]);
});

test("buildAntigravityExecArgs defaults print timeout to runner fail-safe window", () => {
  const cwd = "/tmp/agentteams-project";
  const agentteamsDir = join(cwd, ".agentteams");
  const internalLogPath = join(agentteamsDir, "runner", "log", "trigger.antigravity.log");

  assert.deepEqual(buildAntigravityExecArgs("hello", agentteamsDir, internalLogPath), [
    "--dangerously-skip-permissions",
    "--add-dir",
    agentteamsDir,
    "--log-file",
    internalLogPath,
    "--print-timeout",
    "86400s",
    "--print",
    "hello"
  ]);
});

test("toPowerShellEncodedCommand forwards absolute add-dir and log-file", () => {
  const cwd = "C:\\Users\\agent\\project";
  const agentteamsDir = `${cwd}\\.agentteams`;
  const internalLogPath = `${agentteamsDir}\\runner\\log\\trigger.antigravity.log`;
  const encoded = toPowerShellEncodedCommand("C:\\Tools\\agy.cmd", "hello", agentteamsDir, internalLogPath, 20_000);
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");

  assert.match(decoded, /'--add-dir' 'C:\\Users\\agent\\project\\.agentteams'/);
  assert.match(decoded, /'--log-file' 'C:\\Users\\agent\\project\\.agentteams\\runner\\log\\trigger\.antigravity\.log'/);
  assert.doesNotMatch(decoded, /'--add-dir' '\.agentteams'/);
});

test("createAntigravityInternalLogForwarder polls appended lines without duplicates", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agentteams-antigravity-"));
  const logPath = join(tempDir, "internal.log");
  const forwarded: string[] = [];
  let activityCount = 0;
  const forwarder = createAntigravityInternalLogForwarder({
    logPath,
    triggerId: "trigger-id",
    pollMs: 20,
    onLine: (line) => forwarded.push(line),
    onActivity: () => {
      activityCount += 1;
    }
  });

  try {
    await writeFile(logPath, "language server starting\n");
    forwarder.start();
    await sleep(60);
    await appendFile(logPath, "conversation created\npartial");
    await sleep(60);
    forwarder.stop();
    await forwarder.flush();

    assert.deepEqual(forwarded, [
      "[Antigravity internal log] language server starting",
      "[Antigravity internal log] conversation created",
      "[Antigravity internal log] partial"
    ]);
    assert.equal(activityCount, 3);
  } finally {
    forwarder.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createAntigravityInternalLogForwarder masks secrets and limits each tick", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agentteams-antigravity-"));
  const logPath = join(tempDir, "internal.log");
  const forwarded: string[] = [];
  const lines = [
    "Authorization: Bearer super-secret-token",
    "api_key=abc123",
    ...Array.from({ length: 25 }, (_, index) => `line ${index}`)
  ];
  const forwarder = createAntigravityInternalLogForwarder({
    logPath,
    triggerId: "trigger-id",
    onLine: (line) => forwarded.push(line)
  });

  try {
    await writeFile(logPath, `${lines.join("\n")}\n`);
    await forwarder.flush();

    assert.equal(forwarded.length, 20);
    assert.equal(forwarded[0], "[Antigravity internal log] Authorization: Bearer [REDACTED]");
    assert.equal(forwarded[1], "[Antigravity internal log] api_key=[REDACTED]");
    assert.equal(forwarded.some((line) => line.includes("super-secret-token") || line.includes("abc123")), false);
  } finally {
    forwarder.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sanitizeAntigravityInternalLogLine redacts token-like values", () => {
  const sanitized = sanitizeAntigravityInternalLogLine(
    "access_token: abc refresh_token=def cookie=sessionid token eyJabc.def.ghi"
  );

  assert.equal(sanitized.includes("abc"), false);
  assert.equal(sanitized.includes("def"), false);
  assert.equal(sanitized.includes("eyJabc.def.ghi"), false);
  assert.match(sanitized, /\[REDACTED\]/);
});
