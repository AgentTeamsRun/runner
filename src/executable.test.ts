import assert from "node:assert/strict";
import test from "node:test";
import { buildPowerShellCommand, resolveExecutablePath } from "./executable.js";

test("resolveExecutablePath falls back to npm global bin on Windows", () => {
  const resolved = resolveExecutablePath("opencode", {
    env: {
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    },
    platform: () => "win32",
    execFileSync: ((command: string, args: string[]) => {
      if (command === "where") {
        throw new Error("not found");
      }

      if (command === "npm" && args[0] === "prefix") {
        return "C:\\Users\\rlaru\\AppData\\Roaming\\npm\n";
      }

      throw new Error(`unexpected command: ${command}`);
    }) as typeof import("node:child_process").execFileSync,
    existsSync: ((path: string) => /AppData[\\/]+Roaming[\\/]+npm[\\/]+opencode\.cmd$/u.test(path)) as typeof import("node:fs").existsSync
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Roaming\\npm[\\/]opencode\.cmd$/u);
});

test("resolveExecutablePath prefers PATH lookup results", () => {
  const resolved = resolveExecutablePath("codex", {
    platform: () => "linux",
    execFileSync: ((command: string) => {
      if (command === "which") {
        return "/usr/local/bin/codex\n";
      }

      throw new Error(`unexpected command: ${command}`);
    }) as typeof import("node:child_process").execFileSync
  });

  assert.equal(resolved, "/usr/local/bin/codex");
});

test("buildPowerShellCommand preserves multiline arguments and escapes single quotes", () => {
  const command = buildPowerShellCommand("C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd", [
    "run",
    "line 1\nline '2'"
  ]);

  assert.equal(
    command,
    "& 'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd' 'run' 'line 1\nline ''2'''"
  );
});
