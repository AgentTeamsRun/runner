import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.js";
import { createTriggerHandler } from "./trigger-handler.js";
import type { ConventionMeta, DaemonTrigger, TriggerRuntime } from "../types.js";
import type { RunResult, Runner } from "../runners/types.js";

const trigger: DaemonTrigger = {
  id: "trigger-1",
  prompt: "Implement feature",
  runnerType: "CODEX",
  model: "o4-mini",
  status: "PENDING",
  agentConfigId: "agent-1",
  startedAt: null,
  errorMessage: null,
  worktreeError: null,
  lastHeartbeatAt: null,
  conversationId: null,
  parentTriggerId: "parent-1",
  createdByMemberId: "member-1",
  planMode: false,
  targetDaemonId: null,
  claimedByDaemonId: null,
  useWorktree: false,
  baseBranch: null,
  worktreeId: null,
  worktreeStatus: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const runtime: TriggerRuntime = {
  triggerId: "trigger-1",
  agentConfigId: "agent-1",
  authPath: "/auth/path",
  apiKey: "api-key",
  teamId: "team-1",
  projectId: "project-1",
  parentHistoryMarkdown: null,
  useWorktree: false,
  baseBranch: null,
  worktreeId: null
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
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: "isTriggerCancelRequested", args });
      return false;
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
      idleTimeoutMs: 500,
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
    "isTriggerCancelRequested",
    "updateTriggerHistory",
    "updateTriggerStatus"
  ]);
  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "DONE", undefined]);
});

test("createTriggerHandler strips a UTF-8 BOM before reporting history to the database", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
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
      idleTimeoutMs: 500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async () => ({ exitCode: 0 } satisfies RunResult)
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    readHistoryFile: async () => "\uFEFF### Summary\n- done\n",
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: "/auth/path/.agentteams/runner/history/parent-1.md"
    })
  });

  await handler(trigger);

  assert.deepEqual(clientCalls.at(0)?.args, ["trigger-1", "### Summary\n- done"]);
});

test("createTriggerHandler restores parent history from server-side coaction content", async () => {
  const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: "### Summary\n- restored from coaction\n"
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      idleTimeoutMs: 500,
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

test("createTriggerHandler strips a UTF-8 BOM before restoring parent history from the server", async () => {
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: "\uFEFF### Summary\n- restored from coaction\n"
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      idleTimeoutMs: 500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async () => ({ exitCode: 0 } satisfies RunResult)
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    readHistoryFile: async () => "### Summary\n- current\n",
    writeHistoryFile: async (path, content) => {
      writtenFiles.push({ path, content });
    },
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: "/auth/path/.agentteams/runner/history/parent-1.md"
    })
  });

  await handler(trigger);

  assert.deepEqual(writtenFiles, [{
    path: "/auth/path/.agentteams/runner/history/parent-1.md",
    content: "### Summary\n- restored from coaction"
  }]);
});

test("createTriggerHandler overwrites existing parent history with server cumulative context", async () => {
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: "### Summary\n- cumulative from server\n"
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined
  };

  const handler = createTriggerHandler({
    config: {
      daemonToken: "daemon-token",
      apiUrl: "https://api.example",
      pollingIntervalMs: 5000,
      timeoutMs: 1500,
      idleTimeoutMs: 500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async () => ({ exitCode: 0 } satisfies RunResult)
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    readHistoryFile: async () => "### Summary\n- stale local parent history\n",
    writeHistoryFile: async (path, content) => {
      writtenFiles.push({ path, content });
    },
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: "/auth/path/.agentteams/runner/history/parent-1.md"
    })
  });

  await handler(trigger);

  assert.deepEqual(writtenFiles, [{
    path: "/auth/path/.agentteams/runner/history/parent-1.md",
    content: "### Summary\n- cumulative from server"
  }]);
});

test("createTriggerHandler reports runner failures and falls back to last output", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
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
      idleTimeoutMs: 500,
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
    isTriggerCancelRequested: async () => false,
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
      idleTimeoutMs: 500,
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
  assert.match(String(clientCalls[0]?.args[1]), /Agent output \(history file not written\)/);
  assert.match(String(clientCalls[0]?.args[1]), /agentrunner version 0\.0\.11/);
  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "DONE", undefined]);
});

test("createTriggerHandler truncates long agent output in fallback history", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const longOutput = "x".repeat(2000);

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
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
      idleTimeoutMs: 500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async () => ({
        exitCode: 0,
        outputText: longOutput
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

  const fallbackContent = String(clientCalls[0]?.args[1]);
  assert.match(fallbackContent, /\*\(truncated\)\*/);
  assert.ok(fallbackContent.length < 2000, "Fallback history should be truncated");
});

test("createTriggerHandler cancels the runner when the server reports a cancel request", async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: "isTriggerCancelRequested", args });
      return true;
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
      idleTimeoutMs: 500,
      runnerCmd: "opencode"
    },
    client: client as never
  }, {
    createRunnerFactory: () => () => ({
      run: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
          if (signal?.aborted) {
            resolve();
          }
        });

        return {
          exitCode: 1,
          cancelled: true,
          errorMessage: "Runner cancelled by user"
        } satisfies RunResult;
      }
    }),
    createLogReporter: () => ({
      start: () => undefined,
      append: () => undefined,
      stop: async () => undefined
    }),
    readHistoryFile: async () => "",
    cancelPollIntervalMs: 1,
    resolveRunnerHistoryPaths: () => ({
      currentHistoryPath: "/auth/path/.agentteams/runner/history/trigger-1.md",
      parentHistoryPath: null
    })
  });

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ["trigger-1", "CANCELLED", "Runner cancelled by user"]);
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
    isTriggerCancelRequested: async () => false,
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
      idleTimeoutMs: 500,
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

// ---------------------------------------------------------------------------
// Pre-execution hook tests
// ---------------------------------------------------------------------------

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "trigger-handler-hook-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("createTriggerHandler blocks trigger when pre-hook fails with onFailure=fail", async () => {
  await withTempDir(async (dir) => {
    // Write harness.yml with a failing pre-hook
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "preHooks:",
      "  - name: lint-check",
      "    command: exit 1",
      "    onFailure: fail",
    ].join("\n"));

    const clientCalls: Array<{ method: string; args: unknown[] }> = [];
    let runnerCalled = false;

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, false, "Runner should not be called when pre-hook fails");
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "FAILED");
    assert.ok(String(statusCall.args[2]).includes("lint-check"));
  });
});

test("createTriggerHandler continues when pre-hook fails with onFailure=warn", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "preHooks:",
      "  - name: optional-check",
      "    command: exit 1",
      "    onFailure: warn",
    ].join("\n"));

    let runnerCalled = false;
    const clientCalls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, true, "Runner should still execute when pre-hook fails with warn");
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "DONE");
  });
});

test("createTriggerHandler runs normally when no pre-hooks are defined", async () => {
  await withTempDir(async (dir) => {
    // No harness.yml — should behave exactly as before
    let runnerCalled = false;
    const clientCalls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, true);
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "DONE");
  });
});

test("createTriggerHandler always runs pre-hooks without a convention trigger", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "preHooks:",
      "  - name: always-run",
      "    command: sh -c 'echo always > always.txt && exit 1'",
      "    onFailure: fail",
    ].join("\n"));

    let runnerCalled = false;
    const clientCalls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions: [],
        planType: "BUG_FIX",
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, false);
    assert.equal(await readFile(join(dir, "always.txt"), "utf8"), "always\n");
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "FAILED");
    assert.match(String(statusCall.args[2]), /always-run/);
  });
});

test("createTriggerHandler runs convention-linked pre-hooks when the convention matches", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "preHooks:",
      "  - name: only-on-bugfix",
      "    command: sh -c 'echo bugfix > bugfix.txt && exit 1'",
      "    onFailure: fail",
      "    conventionTrigger: task:BUG_FIX",
    ].join("\n"));

    let runnerCalled = false;
    const clientCalls: Array<{ method: string; args: unknown[] }> = [];
    const conventions: ConventionMeta[] = [{
      id: "conv-bugfix",
      filePath: ".agentteams/rules/bugfix.md",
      trigger: "task:BUG_FIX",
      title: "Bug Fix Convention",
      description: "Rules for bug fix tasks",
    }];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions,
        planType: "BUG_FIX",
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, false);
    assert.equal(await readFile(join(dir, "bugfix.txt"), "utf8"), "bugfix\n");
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "FAILED");
    assert.match(String(statusCall.args[2]), /only-on-bugfix/);
  });
});

test("createTriggerHandler skips convention-linked pre-hooks when the convention does not match", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "preHooks:",
      "  - name: only-on-feature",
      "    command: sh -c 'echo feature > feature.txt && exit 1'",
      "    onFailure: fail",
      "    conventionTrigger: task:FEATURE",
    ].join("\n"));

    let runnerCalled = false;
    const clientCalls: Array<{ method: string; args: unknown[] }> = [];
    const conventions: ConventionMeta[] = [{
      id: "conv-bugfix",
      filePath: ".agentteams/rules/bugfix.md",
      trigger: "task:BUG_FIX",
      title: "Bug Fix Convention",
      description: "Rules for bug fix tasks",
    }];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions,
        planType: "BUG_FIX",
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, true);
    await assert.rejects(access(join(dir, "feature.txt")));
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "DONE");
  });
});

test("createTriggerHandler runs unconditional hooks while skipping non-matching conditional hooks", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "preHooks:",
      "  - name: always-run",
      "    command: sh -c 'echo always > always.txt'",
      "    onFailure: warn",
      "  - name: only-on-feature",
      "    command: sh -c 'echo feature > feature.txt && exit 1'",
      "    onFailure: fail",
      "    conventionTrigger: task:FEATURE",
    ].join("\n"));

    let runnerCalled = false;
    const clientCalls: Array<{ method: string; args: unknown[] }> = [];
    const conventions: ConventionMeta[] = [{
      id: "conv-bugfix",
      filePath: ".agentteams/rules/bugfix.md",
      trigger: "task:BUG_FIX",
      title: "Bug Fix Convention",
      description: "Rules for bug fix tasks",
    }];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions,
        planType: "BUG_FIX",
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerCalled = true;
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerCalled, true);
    assert.equal(await readFile(join(dir, "always.txt"), "utf8"), "always\n");
    await assert.rejects(access(join(dir, "feature.txt")));
    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "DONE");
  });
});

test("createTriggerHandler injects context-matched conventions into the runner prompt", async () => {
  await withTempDir(async (dir) => {
    const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
    const conventions: ConventionMeta[] = [{
      id: "conv-bugfix",
      filePath: ".agentteams/rules/bugfix.md",
      trigger: "task:BUG_FIX",
      title: "Bug Fix Convention",
      description: "Rules for bug fix tasks",
    }];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions,
        planType: "BUG_FIX",
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ prompt: input.prompt, authPath: input.authPath });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerInputs.length, 1);
    assert.match(runnerInputs[0]?.prompt ?? "", /\[IMPORTANT — Convention Reference \(MUST READ\)\]/);
    assert.match(runnerInputs[0]?.prompt ?? "", /\[Context-Matched Conventions \(AUTO-LOADED\)\]/);
    assert.match(runnerInputs[0]?.prompt ?? "", /`\.agentteams\/rules\/bugfix\.md` — Rules for bug fix tasks/);
  });
});

test("createTriggerHandler omits auto-loaded convention prompt section when no conventions match", async () => {
  await withTempDir(async (dir) => {
    const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
    const conventions: ConventionMeta[] = [{
      id: "conv-feature",
      filePath: ".agentteams/rules/feature.md",
      trigger: "task:FEATURE",
      title: "Feature Convention",
      description: "Rules for feature tasks",
    }];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions,
        planType: "BUG_FIX",
      }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler({
      config: {
        daemonToken: "daemon-token",
        apiUrl: "https://api.example",
        pollingIntervalMs: 5000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: "opencode",
      },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ prompt: input.prompt, authPath: input.authPath });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: join(dir, ".agentteams/runner/history/trigger-1.md"),
        parentHistoryPath: null,
      }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerInputs.length, 1);
    assert.match(runnerInputs[0]?.prompt ?? "", /\[IMPORTANT — Convention Reference \(MUST READ\)\]/);
    assert.doesNotMatch(runnerInputs[0]?.prompt ?? "", /Context-Matched Conventions \(AUTO-LOADED\)/);
  });
});

// ---------------------------------------------------------------------------
// Post-execution hook tests
// ---------------------------------------------------------------------------

test("createTriggerHandler marks DONE when post-hook succeeds after runner success", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "postHooks:",
      "  - name: quality-gate",
      "    command: echo ok",
      "    onFailure: fail",
    ].join("\n"));

    const clientCalls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({ ...runtime, authPath: dir }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: { daemonToken: "t", apiUrl: "https://api.example", pollingIntervalMs: 5000, timeoutMs: 1500, idleTimeoutMs: 500, runnerCmd: "opencode" },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({ run: async () => ({ exitCode: 0 } satisfies RunResult) }),
      createLogReporter: () => ({ start: () => undefined, append: () => undefined, stop: async () => undefined }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({ currentHistoryPath: join(dir, "h.md"), parentHistoryPath: null }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "DONE");
  });
});

test("createTriggerHandler marks FAILED when post-hook fails with onFailure=fail", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "postHooks:",
      "  - name: quality-gate",
      "    command: exit 1",
      "    onFailure: fail",
    ].join("\n"));

    const clientCalls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({ ...runtime, authPath: dir }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: { daemonToken: "t", apiUrl: "https://api.example", pollingIntervalMs: 5000, timeoutMs: 1500, idleTimeoutMs: 500, runnerCmd: "opencode" },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({ run: async () => ({ exitCode: 0 } satisfies RunResult) }),
      createLogReporter: () => ({ start: () => undefined, append: () => undefined, stop: async () => undefined }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({ currentHistoryPath: join(dir, "h.md"), parentHistoryPath: null }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "FAILED");
    assert.ok(String(statusCall.args[2]).includes("quality-gate"));
  });
});

test("createTriggerHandler marks NEEDS_REVIEW when post-hook fails with onFailure=needs_review", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "postHooks:",
      "  - name: review-gate",
      "    command: exit 1",
      "    onFailure: needs_review",
    ].join("\n"));

    const clientCalls: Array<{ method: string; args: unknown[] }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({ ...runtime, authPath: dir }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: { daemonToken: "t", apiUrl: "https://api.example", pollingIntervalMs: 5000, timeoutMs: 1500, idleTimeoutMs: 500, runnerCmd: "opencode" },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({ run: async () => ({ exitCode: 0 } satisfies RunResult) }),
      createLogReporter: () => ({ start: () => undefined, append: () => undefined, stop: async () => undefined }),
      readHistoryFile: async () => "### Summary\n- done\n",
      resolveRunnerHistoryPaths: () => ({ currentHistoryPath: join(dir, "h.md"), parentHistoryPath: null }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "NEEDS_REVIEW");
  });
});

test("createTriggerHandler skips post-hooks when runner fails", async () => {
  await withTempDir(async (dir) => {
    const harnessDir = join(dir, ".agentteams");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(join(harnessDir, "harness.yml"), [
      "postHooks:",
      "  - name: should-not-run",
      "    command: echo unreachable",
      "    onFailure: fail",
    ].join("\n"));

    const clientCalls: Array<{ method: string; args: unknown[] }> = [];
    const logEntries: string[] = [];

    const client = {
      fetchTriggerRuntime: async () => ({ ...runtime, authPath: dir }),
      fetchHarnessConfig: async () => null,
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerHistory", args });
      },
      updateTriggerStatus: async (...args: unknown[]) => {
        clientCalls.push({ method: "updateTriggerStatus", args });
      },
    };

    const handler = createTriggerHandler({
      config: { daemonToken: "t", apiUrl: "https://api.example", pollingIntervalMs: 5000, timeoutMs: 1500, idleTimeoutMs: 500, runnerCmd: "opencode" },
      client: client as never,
    }, {
      createRunnerFactory: () => () => ({ run: async () => ({ exitCode: 1 } satisfies RunResult) }),
      createLogReporter: () => ({
        start: () => undefined,
        append: (_level: string, msg: string) => { logEntries.push(msg); },
        stop: async () => undefined,
      }),
      readHistoryFile: async () => "",
      resolveRunnerHistoryPaths: () => ({ currentHistoryPath: join(dir, "h.md"), parentHistoryPath: null }),
    });

    await handler({ ...trigger, parentTriggerId: null });

    const statusCall = clientCalls.find((c) => c.method === "updateTriggerStatus");
    assert.ok(statusCall);
    assert.equal(statusCall.args[1], "FAILED");
    assert.equal(logEntries.some((l) => l.includes("post-execution")), false, "Post-hooks should not run when runner fails");
  });
});
