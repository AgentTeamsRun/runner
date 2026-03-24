import assert from "node:assert/strict";
import test from "node:test";
import { runUpdateCommand } from "./update.js";

test("runUpdateCommand installs latest package and restarts daemon", async () => {
  const commandCalls: Array<{ name: string; args: string[] }> = [];
  const logs: string[] = [];
  let restarted = false;

  await runUpdateCommand({
    runExecutableSync: (name, args) => {
      commandCalls.push({ name, args });
      if (args[0] === "view") {
        return "0.0.13\n";
      }

      return "";
    },
    restartDaemon: async () => {
      restarted = true;
    },
    logger: {
      info: (message) => {
        logs.push(message);
      },
      warn: () => undefined
    }
  });

  assert.deepEqual(commandCalls, [
    {
      name: "npm",
      args: ["view", "@agentteams/runner", "version"]
    },
    {
      name: "npm",
      args: ["install", "-g", "@agentteams/runner@latest"]
    }
  ]);
  assert.equal(restarted, true);
  assert.deepEqual(logs, [
    "Updating AgentRunner package",
    "Package update completed",
    "AgentRunner update completed"
  ]);
});

test("runUpdateCommand continues update when latest version lookup fails", async () => {
  const commandCalls: Array<{ name: string; args: string[] }> = [];
  const warnings: string[] = [];

  await runUpdateCommand({
    runExecutableSync: (name, args) => {
      commandCalls.push({ name, args });
      if (args[0] === "view") {
        throw new Error("network unavailable");
      }

      return "";
    },
    restartDaemon: async () => undefined,
    logger: {
      info: () => undefined,
      warn: (message) => {
        warnings.push(message);
      }
    }
  });

  assert.equal(warnings.length, 1);
  assert.deepEqual(commandCalls, [
    {
      name: "npm",
      args: ["view", "@agentteams/runner", "version"]
    },
    {
      name: "npm",
      args: ["install", "-g", "@agentteams/runner@latest"]
    }
  ]);
});

test("runUpdateCommand surfaces a friendly message when global npm install needs permissions", async () => {
  await assert.rejects(
    () => runUpdateCommand({
      runExecutableSync: (_name, args) => {
        if (args[0] === "view") {
          return "0.0.13\n";
        }

        throw new Error("npm ERR! code EACCES");
      },
      restartDaemon: async () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined
      }
    }),
    /Global npm install requires elevated permissions/u
  );
});

test("runUpdateCommand surfaces install failures with command context", async () => {
  await assert.rejects(
    () => runUpdateCommand({
      runExecutableSync: (_name, args) => {
        if (args[0] === "view") {
          return "0.0.13\n";
        }

        throw new Error("registry unavailable");
      },
      restartDaemon: async () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined
      }
    }),
    /Failed to install the latest AgentRunner package: registry unavailable/u
  );
});
