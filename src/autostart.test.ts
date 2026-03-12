import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { buildPlistContent, buildSystemdContent, buildWindowsVbsContent } from "./autostart.js";

const originalPath = process.env.PATH;

test.afterEach(() => {
  mock.restoreAll();
  process.env.PATH = originalPath;
});

test("buildWindowsVbsContent launches agentrunner hidden with inherited env", () => {
  process.env.PATH = "C:\\Windows\\System32;C:\\Users\\rlaru\\AppData\\Roaming\\npm";

  const content = buildWindowsVbsContent({
    token: "daemon-token",
    apiUrl: "https://api.agentteams.run"
  }, "C:\\Users\\rlaru\\AppData\\Roaming\\npm\\agentrunner.cmd");

  assert.match(content, /Set shell = CreateObject\("WScript\.Shell"\)/u);
  assert.match(content, /env\("AGENTTEAMS_DAEMON_TOKEN"\) = "daemon-token"/u);
  assert.match(content, /env\("AGENTTEAMS_API_URL"\) = "https:\/\/api\.agentteams\.run"/u);
  assert.match(content, /shell\.Run """.*agentrunner\.cmd"" start", 0, False/u);
});

test("buildWindowsVbsContent injects CODEX_SANDBOX_LEVEL=off", () => {
  const content = buildWindowsVbsContent({
    token: "t",
    apiUrl: "http://localhost:3001"
  }, "agentrunner.cmd");

  assert.match(content, /env\("CODEX_SANDBOX_LEVEL"\) = "off"/u);
});

test("buildPlistContent injects CODEX_SANDBOX_LEVEL=off", () => {
  const content = buildPlistContent({
    token: "t",
    apiUrl: "http://localhost:3001"
  });

  assert.match(content, /CODEX_SANDBOX_LEVEL/u);
  assert.match(content, /<key>CODEX_SANDBOX_LEVEL<\/key>\s*\n\s*<string>off<\/string>/u);
});

test("buildSystemdContent injects CODEX_SANDBOX_LEVEL=off", () => {
  const content = buildSystemdContent({
    token: "t",
    apiUrl: "http://localhost:3001"
  });

  assert.match(content, /Environment="CODEX_SANDBOX_LEVEL=off"/u);
});
