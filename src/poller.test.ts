import assert from "node:assert/strict";
import * as fsModule from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { logger } from "./logger.js";
import { startPolling } from "./poller.js";
import type { DaemonTrigger, RuntimeConfig } from "./types.js";

const config: RuntimeConfig = {
  daemonToken: "daemon-token",
  apiUrl: "https://api.example",
  pollingIntervalMs: 5000,
  timeoutMs: 1000,
  idleTimeoutMs: 500,
  runnerCmd: "opencode"
};

const trigger: DaemonTrigger = {
  id: "trigger-1",
  prompt: "hello",
  runnerType: "CODEX",
  model: "o4-mini",
  status: "PENDING",
  agentConfigId: "agent-1",
  startedAt: null,
  errorMessage: null,
  worktreeError: null,
  lastHeartbeatAt: null,
  conversationId: null,
  parentTriggerId: null,
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

test.afterEach(() => {
  mock.restoreAll();
});

test("startPolling handles a claimed trigger, registers auth paths, and runs scheduled cleanup", async () => {
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, "info", (message: string, meta?: Record<string, unknown>) => {
    infos.push({ message, meta });
  });

  const signals = new Map<string, () => void>();
  const intervalCallbacks: Array<() => void> = [];
  const cleanupCalls: string[] = [];
  const handledTriggers: string[] = [];
  const savedAuthPaths: string[] = [];
  let nowValue = 0;

  const pending = [trigger, null];
  const client = {
    fetchPendingTrigger: async () => ({ data: pending.shift() ?? null }),
    claimTrigger: async () => ({ ok: true, conflict: false }),
    fetchOrphanedCancelRequested: async () => [] as string[],
    updateTriggerStatus: async () => undefined,
    fetchPendingWorktreeRemovals: async () => [],
    reportWorktreeStatus: async () => undefined,
    notifyUpdate: async () => undefined
  };

  const createHandler = (onAuthPathDiscovered: (authPath: string) => void) => {
    onAuthPathDiscovered("/auth/path");
    return async (value: DaemonTrigger) => {
      handledTriggers.push(value.id);
    };
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, createHandler, {
    createClient: () => client,
    runCleanup: async (authPath: string) => {
      cleanupCalls.push(authPath);
    },
    setInterval: ((callback: () => void) => {
      intervalCallbacks.push(callback);
      return { ref() {}, unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: ((event: NodeJS.Signals, listener: () => void) => {
      signals.set(event, listener);
    }) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error("should not exit");
    }) as (code: number) => never,
    now: () => nowValue,
    loadAuthPaths: () => [],
    saveAuthPath: (authPath: string) => {
      savedAuthPaths.push(authPath);
      return "/tmp/auth-paths.json";
    },
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handledTriggers, ["trigger-1"]);
  assert.deepEqual(cleanupCalls, []);
  assert.equal(intervalCallbacks.length, 1);

  nowValue = 24 * 60 * 60 * 1000 + 1;
  await intervalCallbacks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(cleanupCalls, ["/auth/path"]);
  assert.deepEqual(savedAuthPaths, ["/auth/path"]);
  assert.equal(signals.has("SIGINT"), true);
  assert.equal(signals.has("SIGTERM"), true);
  assert.equal(infos.some((entry) => entry.message === "Daemon polling started"), true);

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
});

test("startPolling logs conflicts and suppresses overlapping polling cycles", async () => {
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, "info", (message: string, meta?: Record<string, unknown>) => {
    infos.push({ message, meta });
  });

  let releaseFetch: (() => void) | null = null;
  const client = {
    fetchPendingTrigger: async () => await new Promise<{ data: DaemonTrigger | null }>((resolve) => {
      releaseFetch = () => resolve({ data: trigger });
    }),
    claimTrigger: async () => ({ ok: false, conflict: true }),
    fetchOrphanedCancelRequested: async () => [] as string[],
    updateTriggerStatus: async () => undefined,
    fetchPendingWorktreeRemovals: async () => [],
    reportWorktreeStatus: async () => undefined,
    notifyUpdate: async () => undefined
  };

  const intervalCallbacks: Array<() => void> = [];
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => {
    throw new Error("handler should not run");
  }, {
    createClient: () => client,
    runCleanup: async () => undefined,
    setInterval: ((callback: () => void) => {
      intervalCallbacks.push(callback);
      return {} as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error("should not exit");
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => "/tmp/auth-paths.json",
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  await intervalCallbacks[0]?.();
  const releasePendingFetch = releaseFetch ?? (() => {
    throw new Error("fetch release was not registered");
  });
  releasePendingFetch();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(infos.some((entry) => entry.message === "Trigger already claimed by another daemon"), true);

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
});

test("startPolling clears the interval and exits on shutdown signals", async () => {
  const signals = new Map<string, () => void>();
  const cleared: NodeJS.Timeout[] = [];
  let keepAliveResolve: (() => void) | null = null;
  let exitCode: number | null = null;

  const intervalHandle = {} as NodeJS.Timeout;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => ({
      fetchPendingTrigger: async () => ({ data: null }),
      claimTrigger: async () => ({ ok: true, conflict: false }),
      fetchOrphanedCancelRequested: async () => [] as string[],
      updateTriggerStatus: async () => undefined,
      fetchPendingWorktreeRemovals: async () => [],
      reportWorktreeStatus: async () => undefined,
      notifyUpdate: async () => undefined
    }),
    runCleanup: async () => undefined,
    setInterval: (() => intervalHandle) as typeof setInterval,
    clearInterval: ((handle: NodeJS.Timeout) => {
      cleared.push(handle);
    }) as typeof clearInterval,
    processOn: ((event: NodeJS.Signals, listener: () => void) => {
      signals.set(event, listener);
    }) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: ((code: number) => {
      exitCode = code;
      return undefined as never;
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => "/tmp/auth-paths.json",
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  }).catch((error: Error) => {
    if (error.message !== "exit") {
      throw error;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signals.get("SIGTERM"));

  const sigterm = signals.get("SIGTERM");
  assert.ok(sigterm);
  sigterm();
  assert.equal(exitCode, 0);
  assert.deepEqual(cleared, [intervalHandle]);

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
});

test("startPolling delegates auto-update via injected dependency", async () => {
  let autoUpdateCallCount = 0;
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => ({
      fetchPendingTrigger: async () => ({
        data: null,
        meta: { cliLatestVersion: null, runnerLatestVersion: "99.0.0" }
      }),
      claimTrigger: async () => ({ ok: true, conflict: false }),
      fetchOrphanedCancelRequested: async () => [] as string[],
      updateTriggerStatus: async () => undefined,
      fetchPendingWorktreeRemovals: async () => [],
      reportWorktreeStatus: async () => undefined,
      notifyUpdate: async () => undefined
    }),
    runCleanup: async () => undefined,
    maybeAutoUpdate: async () => {
      autoUpdateCallCount++;
      return { cliUpdated: false, runnerUpdated: false };
    },
    setInterval: (() => ({} as NodeJS.Timeout)) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => "/tmp/auth-paths.json",
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(autoUpdateCallCount, 1, "should call injected maybeAutoUpdate on idle poll");

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
});

test("startPolling restores persisted auth paths for worktree removals after restart", async () => {
  const removedWorktrees: Array<{ authPath: string; worktreePath: string; worktreeId: string }> = [];
  const reportedStatuses: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
  const tempRoot = fsModule.mkdtempSync(path.join(os.tmpdir(), "agentrunner-poller-"));
  const authPath = path.join(tempRoot, "path");
  const worktreePath = path.join(tempRoot, ".path-worktrees", "wt-worktree-1");
  fsModule.mkdirSync(authPath, { recursive: true });
  fsModule.mkdirSync(worktreePath, { recursive: true });
  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: "trigger-remove",
    useWorktree: true,
    worktreeId: "worktree-1",
    worktreeStatus: "REMOVE_REQUESTED"
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => ({
      fetchPendingTrigger: async () => ({ data: null }),
      claimTrigger: async () => ({ ok: true, conflict: false }),
      fetchOrphanedCancelRequested: async () => [] as string[],
      updateTriggerStatus: async () => undefined,
      fetchPendingWorktreeRemovals: async () => [worktreeRemovalTrigger],
      reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
        reportedStatuses.push({ triggerId, status, worktreeError });
      },
      notifyUpdate: async () => undefined
    }),
    runCleanup: async () => undefined,
    removeWorktree: (authPath: string, worktreePath: string, worktreeId: string) => {
      removedWorktrees.push({ authPath, worktreePath, worktreeId });
    },
    setInterval: (() => ({ ref() {}, unref() {} } as unknown as NodeJS.Timeout)) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error("should not exit");
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [authPath],
    saveAuthPath: () => "/tmp/auth-paths.json",
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(removedWorktrees, [{
    authPath,
    worktreePath,
    worktreeId: "worktree-1"
  }]);
  assert.deepEqual(reportedStatuses, [{ triggerId: "trigger-remove", status: "REMOVED", worktreeError: undefined }]);

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
  fsModule.rmSync(tempRoot, { recursive: true, force: true });
});

test("startPolling reports FAILED when no persisted auth path matches the worktree", async () => {
  const reportedStatuses: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: "trigger-remove-missing",
    useWorktree: true,
    worktreeId: "worktree-missing",
    worktreeStatus: "REMOVE_REQUESTED"
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => ({
      fetchPendingTrigger: async () => ({ data: null }),
      claimTrigger: async () => ({ ok: true, conflict: false }),
      fetchOrphanedCancelRequested: async () => [] as string[],
      updateTriggerStatus: async () => undefined,
      fetchPendingWorktreeRemovals: async () => [worktreeRemovalTrigger],
      reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
        reportedStatuses.push({ triggerId, status, worktreeError });
      },
      notifyUpdate: async () => undefined
    }),
    runCleanup: async () => undefined,
    removeWorktree: () => {
      throw new Error("removeWorktree should not be called");
    },
    setInterval: (() => ({ ref() {}, unref() {} } as unknown as NodeJS.Timeout)) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error("should not exit");
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => ["/persisted/auth/path"],
    saveAuthPath: () => "/tmp/auth-paths.json",
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reportedStatuses, [{
    triggerId: "trigger-remove-missing",
    status: "FAILED",
    worktreeError: "Failed to remove RunnerBox: worktree path was not found for worktree-missing"
  }]);

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
});

test("startPolling reports FAILED when worktree removal throws after matching a path", async () => {
  const reportedStatuses: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
  const tempRoot = fsModule.mkdtempSync(path.join(os.tmpdir(), "agentrunner-poller-"));
  const authPath = path.join(tempRoot, "path");
  const worktreePath = path.join(tempRoot, ".path-worktrees", "wt-worktree-failed");
  fsModule.mkdirSync(authPath, { recursive: true });
  fsModule.mkdirSync(worktreePath, { recursive: true });
  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: "trigger-remove-failed",
    useWorktree: true,
    worktreeId: "worktree-failed",
    worktreeStatus: "REMOVE_REQUESTED"
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => ({
      fetchPendingTrigger: async () => ({ data: null }),
      claimTrigger: async () => ({ ok: true, conflict: false }),
      fetchOrphanedCancelRequested: async () => [] as string[],
      updateTriggerStatus: async () => undefined,
      fetchPendingWorktreeRemovals: async () => [worktreeRemovalTrigger],
      reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
        reportedStatuses.push({ triggerId, status, worktreeError });
      },
      notifyUpdate: async () => undefined
    }),
    runCleanup: async () => undefined,
    removeWorktree: () => {
      throw new Error("permission denied");
    },
    setInterval: (() => ({ ref() {}, unref() {} } as unknown as NodeJS.Timeout)) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error("should not exit");
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [authPath],
    saveAuthPath: () => "/tmp/auth-paths.json",
    keepAlive: () => new Promise<void>((resolve) => {
      keepAliveResolve = resolve;
    })
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reportedStatuses, [{
    triggerId: "trigger-remove-failed",
    status: "FAILED",
    worktreeError: "permission denied"
  }]);

  const resolveKeepAlive = keepAliveResolve ?? (() => {
    throw new Error("keepAlive resolver was not registered");
  });
  resolveKeepAlive();
  await pollingPromise;
  fsModule.rmSync(tempRoot, { recursive: true, force: true });
});
