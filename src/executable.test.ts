import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPowerShellCommand,
  resolveExecutablePath,
  resolveExecutablePathWithPreference
} from "./executable.js";

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
    }) as unknown as typeof import("node:child_process").execFileSync,
    existsSync: ((path: string) => /AppData[\\/]+Roaming[\\/]+npm[\\/]+opencode\.cmd$/u.test(path)) as typeof import("node:fs").existsSync
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Roaming\\npm[\\/]opencode\.cmd$/u);
});

test("resolveExecutablePath falls back to Antigravity local app bin on Windows", () => {
  const resolved = resolveExecutablePath("agy", {
    env: {
      LOCALAPPDATA: "C:\\Users\\rlaru\\AppData\\Local",
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    },
    platform: () => "win32",
    execFileSync: ((command: string, args?: readonly string[]) => {
      if (command === "where") {
        throw new Error("not found");
      }

      if (command === "npm" && args?.[0] === "prefix") {
        throw new Error("npm unavailable");
      }

      throw new Error(`unexpected command: ${command}`);
    }) as unknown as typeof import("node:child_process").execFileSync,
    existsSync: ((path: string) => /AppData[\\/]+Local[\\/]+agy[\\/]+bin[\\/]+agy\.exe$/u.test(path)) as typeof import("node:fs").existsSync
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Local[\\/]agy[\\/]bin[\\/]agy\.exe$/u);
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

test("resolveExecutablePathWithPreference prefers opencode.cmd on Windows", () => {
  const resolved = resolveExecutablePathWithPreference("opencode", ["opencode.cmd", "opencode"], {
    platform: () => "win32",
    execFileSync: ((command: string, args: string[]) => {
      if (command === "where" && args[0] === "opencode.cmd") {
        return "C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd\n";
      }

      if (command === "where" && args[0] === "opencode") {
        return "C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode\n";
      }

      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as typeof import("node:child_process").execFileSync
  });

  assert.equal(resolved, "C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd");
});

test("resolveExecutablePathWithPreference falls back to agy.exe for preferred agy names on Windows", () => {
  const resolved = resolveExecutablePathWithPreference("agy", ["agy.cmd", "agy"], {
    env: {
      LOCALAPPDATA: "C:\\Users\\rlaru\\AppData\\Local",
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    },
    platform: () => "win32",
    execFileSync: ((command: string, args?: readonly string[]) => {
      if (command === "where") {
        throw new Error("not found");
      }

      if (command === "npm" && args?.[0] === "prefix") {
        throw new Error("npm unavailable");
      }

      throw new Error(`unexpected command: ${command} ${args?.join(" ") ?? ""}`);
    }) as unknown as typeof import("node:child_process").execFileSync,
    existsSync: ((path: string) => /AppData[\\/]+Local[\\/]+agy[\\/]+bin[\\/]+agy\.exe$/u.test(path)) as typeof import("node:fs").existsSync
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Local[\\/]agy[\\/]bin[\\/]agy\.exe$/u);
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
