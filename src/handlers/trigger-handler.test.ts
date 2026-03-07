import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { logger } from "../logger.js";
import { createTriggerHandler } from "./trigger-handler.js";
import type { DaemonTrigger, TriggerRuntime } from "../types.js";
import type { RunResult, Runner } from "../runners/types.js";

const trigger: DaemonTrigger = {
  id: "trigger-1",
  prompt: "Implement feature",
  runnerType: "CODEX",
  status: "PENDING",
  agentConfigId: "agent-1",
  startedAt: null,
  errorMessage: null,
  historyMarkdown: null,
  lastHeartbeatAt: null,
  conversationId: null,
  parentTriggerId: "parent-1",
  createdByMemberId: "member-1",
  claimedByDaemonId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const runtime: TriggerRuntime = {
  triggerId: "trigger-1",
  agentConfigId: "agent-1",
  authPath: "/auth/path",
  apiKey: "api-key",
  parentHistoryMarkdown: null
};

test.afterEach(() => {
  mock.restoreAll();
});

test("createTriggerHandler runs the runner, reports history, and marks success", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const logEntries: Array<{ level: string; message: string }> = [];
  const discoveredAuthPaths: string[] = [];
  const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];

  const client = {
    fetchTriggerRuntime: async (...args: unknown[]) => {
      clientCalls.push({ method: "fetchTriggerRuntime", args });
      return runtime;
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerHistory", args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerStatus", args });
    }
  };

  const runner: Runner = {
    run: async (input) => {
      runnerInputs.push({ prompt: input.prompt, authPath: input.authPath });
      input.onStdoutChunk?.("stdout");
      input.onStderrChunk?.("stderr");
      return { exitCode: 0 };
    }
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      runnerCmd: "opencode"
    },
    client: client as never,
    onAuthPathDiscovered: (authPath) => {
      discoveredAuthPaths.push(authPath);
    }
  }, {
    createRunnerFactory: () => () => runner,
    createLogReporter: () => ({
      start: () => {
        logEntries.push({ level: "START", message: "started" });
      },
      append: (level, message) => {
        logEntries.push({ level, message });
      },
      stop: async () => {
        logEntries.push({ level: "STOP", message: "stopped" });
      }
    }),
    readHistoryFile: async () => "### Summary\n- done\n",
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: "/auth/path/.agentteams/runner/history/parent-1.md"
    })
  });

  await handler(trigger);

  assert.deepEqual(discoveredAuthPaths, ["/auth/path"]);
  assert.equal(runnerInputs.length, 1);
  assert.match(runnerInputs[0]?.prompt ?? "", /Continuation context \(required\)/);
  assert.match(runnerInputs[0]?.prompt ?? "", /Previous history path: \/auth\/path\/\.agentteams\/runner\/history\/parent-1\.md/);
  assert.equal(logEntries.some((entry) => entry.level === "INFO" && entry.message.includes("stdout")), true);
  assert.equal(logEntries.some((entry) => entry.level === "WARN" && entry.message.includes("stderr")), true);
  assert.deepEqual(clientCalls.map((entry) => entry.method), [
    "fetchTriggerRuntime",
    "updateTriggerHistory",
    "updateTriggerStatus"
  ]);
  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "DONE", undefined]);
});

test("createTriggerHandler restores parent history from server-side coaction content", async () => {
  const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: "### Summary\n- restored from coaction\n"
    }),
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async (input) => {
        runnerInputs.push({ prompt: input.prompt, authPath: input.authPath });
        return { exitCode: 0 } satisfies RunResult;
      }
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    readHistoryFile: async (path) => {
      if (String(path).endsWith("parent-1.md")) {
        throw new Error("ENOENT");
      }
      return "### Summary\n- current\n";
    },
    writeHistoryFile: async (path, content) => {
      writtenFiles.push({ path, content });
    },
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: "/auth/path/.agentteams/runner/history/parent-1.md"
    })
  });

  await handler(trigger);

  assert.equal(runnerInputs.length, 1);
  assert.deepEqual(writtenFiles, [{
    path: "/auth/path/.agentteams/runner/history/parent-1.md",
    content: "### Summary\n- restored from coaction"
  }]);
});

test("createTriggerHandler reports runner failures and falls back to last output", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerHistory", args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerStatus", args });
    }
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async () => ({ exitCode: 1, lastOutput: "last output" } satisfies RunResult)
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    readHistoryFile: async () => "",
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: null
    })
  });

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "FAILED", "last output"]);
});

test("createTriggerHandler stores stdout as fallback history when the runner omits the history file", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerHistory", args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerStatus", args });
    }
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async () => ({
        exitCode: 0,
        outputText: "agentrunner version 0.0.11"
      } satisfies RunResult)
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    writeHistoryFile: async (path, content) => {
      writtenFiles.push({ path, content });
    },
    readHistoryFile: async () => {
      throw new Error("ENOENT");
    },
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: null
    })
  });

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.map((entry) => entry.method), [
    "updateTriggerHistory",
    "updateTriggerStatus"
  ]);
  assert.equal(writtenFiles.length, 1);
  assert.equal(writtenFiles[0]?.path, "/auth/path/.agentteams/runner/history/trigger-1.md");
  assert.match(String(clientCalls[0]?.args[1]), /agentrunner version 0\.0\.11/);
  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "DONE", undefined]);
});

test("createTriggerHandler marks the trigger as failed when runtime loading throws", async () => {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, "error", (message: string, meta?: Record<string, unknown>) => {
    errors.push({ message, meta });
  });

  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    fetchTriggerRuntime: async () => {
      throw new Error("runtime boom");
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerHistory", args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: "updateTriggerStatus", args });
    }
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    })
  });

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "FAILED", "runtime boom"]);
  assert.equal(errors.some((entry) => entry.message === "Trigger handling failed"), true);
});
