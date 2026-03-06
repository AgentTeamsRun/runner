import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { buildWindowsVbsContent } from "./autostart.js";

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
