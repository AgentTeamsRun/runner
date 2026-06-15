import assert from 'node:assert/strict';
import * as fsModule from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { logger } from './logger.js';
import { startPolling } from './poller.js';
import type { DaemonTrigger, PollStateResponse, RuntimeConfig } from './types.js';

const config: RuntimeConfig = {
  daemonToken: 'daemon-token',
  apiUrl: 'https://api.example',
  pollingIntervalMs: 5000,
  timeoutMs: 1000,
  idleTimeoutMs: 500,
  runnerCmd: 'opencode',
  preventSleepWhileBusy: false,
};

const trigger: DaemonTrigger = {
  id: 'trigger-1',
  prompt: 'hello',
  runnerType: 'CODEX',
  model: 'o4-mini',
  fastMode: false,
  status: 'PENDING',
  agentConfigId: 'agent-1',
  startedAt: null,
  errorMessage: null,
  worktreeError: null,
  lastHeartbeatAt: null,
  conversationId: null,
  parentTriggerId: null,
  createdByMemberId: 'member-1',
  planMode: false,
  targetDaemonId: null,
  claimedByDaemonId: null,
  useWorktree: false,
  baseBranch: null,
  worktreeId: null,
  worktreeStatus: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test.afterEach(() => {
  mock.restoreAll();
});

// 통합 snapshot 응답을 만든다. 개별 항목은 override로 지정한다.
const pollState = (
  overrides: Partial<PollStateResponse['data']> = {},
  meta?: PollStateResponse['meta'],
): PollStateResponse => ({
  data: {
    orphanedCancelRequestedTriggerIds: [],
    pendingWorktreeRemovals: [],
    pendingTrigger: null,
    ...overrides,
  },
  ...(meta ? { meta } : {}),
});

type PollClientOverrides = {
  fetchPollState?: () => Promise<PollStateResponse>;
  claimTrigger?: (triggerId: string) => Promise<{ ok: boolean; conflict: boolean }>;
  updateTriggerStatus?: (triggerId: string, status: string, errorMessage?: string) => Promise<void>;
  reportWorktreeStatus?: (triggerId: string, status: string, worktreeError?: string) => Promise<void>;
  notifyUpdate?: () => Promise<void>;
  ackRestartRequest?: () => Promise<void>;
};

// 기본은 idle(아무 작업 없음) 러너 클라이언트. 필요한 동작만 override한다.
const makeClient = (overrides: PollClientOverrides = {}) => ({
  fetchPollState: overrides.fetchPollState ?? (async () => pollState()),
  claimTrigger: overrides.claimTrigger ?? (async () => ({ ok: true, conflict: false })),
  updateTriggerStatus: overrides.updateTriggerStatus ?? (async () => undefined),
  reportWorktreeStatus: overrides.reportWorktreeStatus ?? (async () => undefined),
  notifyUpdate: overrides.notifyUpdate ?? (async () => undefined),
  ackRestartRequest: overrides.ackRestartRequest ?? (async () => undefined),
});

type BlockerEvents = { events: string[]; blocker: { acquire: (label?: string) => () => void } };

const createRecordingBlocker = (): BlockerEvents => {
  const events: string[] = [];
  return {
    events,
    blocker: {
      acquire: (label?: string) => {
        events.push(`acquire:${label ?? ''}`);
        return () => events.push(`release:${label ?? ''}`);
      },
    },
  };
};

test('startPolling handles a claimed trigger, registers auth paths, and runs scheduled cleanup', async () => {
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, 'info', (message: string, meta?: Record<string, unknown>) => {
    infos.push({ message, meta });
  });

  const signals = new Map<string, () => void>();
  const intervalCallbacks: Array<() => void> = [];
  const cleanupCalls: string[] = [];
  const handledTriggers: string[] = [];
  const savedAuthPaths: string[] = [];
  let nowValue = 0;

  const pending = [trigger, null];
  const client = makeClient({
    fetchPollState: async () => pollState({ pendingTrigger: pending.shift() ?? null }),
  });

  const createHandler = (onAuthPathDiscovered: (authPath: string) => void) => {
    onAuthPathDiscovered('/auth/path');
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
    runConventionSync: async () => undefined,
    setInterval: ((callback: () => void) => {
      intervalCallbacks.push(callback);
      return { ref() {}, unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: ((event: NodeJS.Signals, listener: () => void) => {
      signals.set(event, listener);
    }) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error('should not exit');
    }) as (code: number) => never,
    now: () => nowValue,
    loadAuthPaths: () => [],
    saveAuthPath: (authPath: string) => {
      savedAuthPaths.push(authPath);
      return '/tmp/auth-paths.json';
    },
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handledTriggers, ['trigger-1']);
  assert.deepEqual(cleanupCalls, []);
  assert.equal(intervalCallbacks.length, 1);

  nowValue = 24 * 60 * 60 * 1000 + 1;
  await intervalCallbacks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(cleanupCalls, ['/auth/path']);
  assert.deepEqual(savedAuthPaths, ['/auth/path']);
  assert.equal(signals.has('SIGINT'), true);
  assert.equal(signals.has('SIGTERM'), true);
  assert.equal(
    infos.some((entry) => entry.message === 'Daemon polling started'),
    true,
  );

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling processes orphaned cancel, worktree removal, and pending claim from a single poll-state fetch', async () => {
  const order: string[] = [];
  let pollStateCalls = 0;
  const handledTriggers: string[] = [];

  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: 'trigger-worktree',
    useWorktree: true,
    worktreeId: 'worktree-unmatched',
    worktreeStatus: 'REMOVE_REQUESTED',
  };

  const pending = [
    pollState({
      orphanedCancelRequestedTriggerIds: ['orphan-1'],
      pendingWorktreeRemovals: [worktreeRemovalTrigger],
      pendingTrigger: trigger,
    }),
    pollState(),
  ];

  const client = makeClient({
    fetchPollState: async () => {
      pollStateCalls += 1;
      return pending.shift() ?? pollState();
    },
    updateTriggerStatus: async (triggerId: string) => {
      order.push(`cancel:${triggerId}`);
    },
    reportWorktreeStatus: async (triggerId: string, status: string) => {
      order.push(`worktree:${triggerId}:${status}`);
    },
    claimTrigger: async (triggerId: string) => {
      order.push(`claim:${triggerId}`);
      return { ok: true, conflict: false };
    },
  });

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(
    config,
    () => async (value: DaemonTrigger) => {
      handledTriggers.push(value.id);
    },
    {
      createClient: () => client,
      runCleanup: async () => undefined,
      runConventionSync: async () => undefined,
      // 워크트리 경로가 매칭되지 않도록 존재하지 않는 authPath를 사용 → 멱등 제거 완료 경로.
      loadAuthPaths: () => ['/nonexistent/auth/path'],
      saveAuthPath: () => '/tmp/auth-paths.json',
      setInterval: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
      processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
      processExit: (() => {
        throw new Error('should not exit');
      }) as (code: number) => never,
      now: () => 0,
      keepAlive: () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    },
  );

  await new Promise((resolve) => setImmediate(resolve));

  // 한 cycle에서 read는 통합 snapshot 1회로 줄어든다.
  assert.equal(pollStateCalls, 1, 'a single polling cycle should fetch poll-state exactly once');
  // 처리 순서는 기존과 동일: 고아 취소 → 워크트리 제거 → pending claim.
  assert.deepEqual(order, ['cancel:orphan-1', 'worktree:trigger-worktree:REMOVED', 'claim:trigger-1']);
  assert.deepEqual(handledTriggers, ['trigger-1']);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling runs convention sync per auth path every 6 hours', async () => {
  const intervalCallbacks: Array<() => void> = [];
  const conventionSyncCalls: string[] = [];
  let nowValue = 6 * 60 * 60 * 1000 + 1;
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
    runCleanup: async () => undefined,
    runConventionSync: async (authPath: string) => {
      conventionSyncCalls.push(authPath);
    },
    maybeAutoUpdate: async () => ({ cliUpdated: false, runnerUpdated: false }),
    setInterval: ((callback: () => void) => {
      intervalCallbacks.push(callback);
      return { ref() {}, unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error('should not exit');
    }) as (code: number) => never,
    now: () => nowValue,
    loadAuthPaths: () => ['/auth/path'],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(conventionSyncCalls, ['/auth/path']);
  assert.equal(intervalCallbacks.length, 1);

  nowValue += 6 * 60 * 60 * 1000 - 1;
  await intervalCallbacks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(conventionSyncCalls, ['/auth/path']);

  nowValue += 1;
  await intervalCallbacks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(conventionSyncCalls, ['/auth/path', '/auth/path']);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling logs conflicts and suppresses overlapping polling cycles', async () => {
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, 'info', (message: string, meta?: Record<string, unknown>) => {
    infos.push({ message, meta });
  });

  let releaseFetch: (() => void) | null = null;
  const client = makeClient({
    fetchPollState: async () =>
      await new Promise<PollStateResponse>((resolve) => {
        releaseFetch = () => resolve(pollState({ pendingTrigger: trigger }));
      }),
    claimTrigger: async () => ({ ok: false, conflict: true }),
  });

  const intervalCallbacks: Array<() => void> = [];
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(
    config,
    () => async () => {
      throw new Error('handler should not run');
    },
    {
      createClient: () => client,
      runCleanup: async () => undefined,
      setInterval: ((callback: () => void) => {
        intervalCallbacks.push(callback);
        return {} as NodeJS.Timeout;
      }) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
      processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
      processExit: (() => {
        throw new Error('should not exit');
      }) as (code: number) => never,
      now: () => 0,
      loadAuthPaths: () => [],
      saveAuthPath: () => '/tmp/auth-paths.json',
      keepAlive: () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  await intervalCallbacks[0]?.();
  const releasePendingFetch =
    releaseFetch ??
    (() => {
      throw new Error('fetch release was not registered');
    });
  releasePendingFetch();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    infos.some((entry) => entry.message === 'Trigger already claimed by another daemon'),
    true,
  );

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling clears the interval and exits on shutdown signals', async () => {
  const signals = new Map<string, () => void>();
  const cleared: NodeJS.Timeout[] = [];
  let keepAliveResolve: (() => void) | null = null;
  let exitCode: number | null = null;

  const intervalHandle = {} as NodeJS.Timeout;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
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
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  }).catch((error: Error) => {
    if (error.message !== 'exit') {
      throw error;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signals.get('SIGTERM'));

  const sigterm = signals.get('SIGTERM');
  assert.ok(sigterm);
  sigterm();
  assert.equal(exitCode, 0);
  assert.deepEqual(cleared, [intervalHandle]);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling delegates auto-update via injected dependency', async () => {
  let autoUpdateCallCount = 0;
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => pollState({}, { cliLatestVersion: null, runnerLatestVersion: '99.0.0' }),
      }),
    runCleanup: async () => undefined,
    maybeAutoUpdate: async () => {
      autoUpdateCallCount++;
      return { cliUpdated: false, runnerUpdated: false };
    },
    setInterval: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(autoUpdateCallCount, 1, 'should call injected maybeAutoUpdate on idle poll');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling restores persisted auth paths for worktree removals after restart', async () => {
  const removedWorktrees: Array<{ authPath: string; worktreePath: string; worktreeId: string }> = [];
  const reportedStatuses: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
  const tempRoot = fsModule.mkdtempSync(path.join(os.tmpdir(), 'agentrunner-poller-'));
  const authPath = path.join(tempRoot, 'path');
  const worktreePath = path.join(tempRoot, '.path-worktrees', 'wt-worktree-1');
  fsModule.mkdirSync(authPath, { recursive: true });
  fsModule.mkdirSync(worktreePath, { recursive: true });
  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: 'trigger-remove',
    useWorktree: true,
    worktreeId: 'worktree-1',
    worktreeStatus: 'REMOVE_REQUESTED',
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => pollState({ pendingWorktreeRemovals: [worktreeRemovalTrigger] }),
        reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
          reportedStatuses.push({ triggerId, status, worktreeError });
        },
      }),
    runCleanup: async () => undefined,
    removeWorktree: (authPath: string, worktreePath: string, worktreeId: string) => {
      removedWorktrees.push({ authPath, worktreePath, worktreeId });
    },
    setInterval: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error('should not exit');
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [authPath],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(removedWorktrees, [
    {
      authPath,
      worktreePath,
      worktreeId: 'worktree-1',
    },
  ]);
  assert.deepEqual(reportedStatuses, [{ triggerId: 'trigger-remove', status: 'REMOVED', worktreeError: undefined }]);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
  fsModule.rmSync(tempRoot, { recursive: true, force: true });
});

test('startPolling reports REMOVED when no persisted auth path matches the worktree', async () => {
  const reportedStatuses: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: 'trigger-remove-missing',
    useWorktree: true,
    worktreeId: 'worktree-missing',
    worktreeStatus: 'REMOVE_REQUESTED',
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => pollState({ pendingWorktreeRemovals: [worktreeRemovalTrigger] }),
        reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
          reportedStatuses.push({ triggerId, status, worktreeError });
        },
      }),
    runCleanup: async () => undefined,
    removeWorktree: () => {
      throw new Error('removeWorktree should not be called');
    },
    setInterval: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error('should not exit');
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => ['/persisted/auth/path'],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reportedStatuses, [
    {
      triggerId: 'trigger-remove-missing',
      status: 'REMOVED',
      worktreeError: undefined,
    },
  ]);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling reports FAILED when worktree removal throws after matching a path', async () => {
  const reportedStatuses: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
  const tempRoot = fsModule.mkdtempSync(path.join(os.tmpdir(), 'agentrunner-poller-'));
  const authPath = path.join(tempRoot, 'path');
  const worktreePath = path.join(tempRoot, '.path-worktrees', 'wt-worktree-failed');
  fsModule.mkdirSync(authPath, { recursive: true });
  fsModule.mkdirSync(worktreePath, { recursive: true });
  const worktreeRemovalTrigger: DaemonTrigger = {
    ...trigger,
    id: 'trigger-remove-failed',
    useWorktree: true,
    worktreeId: 'worktree-failed',
    worktreeStatus: 'REMOVE_REQUESTED',
  };

  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => pollState({ pendingWorktreeRemovals: [worktreeRemovalTrigger] }),
        reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
          reportedStatuses.push({ triggerId, status, worktreeError });
        },
      }),
    runCleanup: async () => undefined,
    removeWorktree: () => {
      throw new Error('permission denied');
    },
    setInterval: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => {
      throw new Error('should not exit');
    }) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [authPath],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reportedStatuses, [
    {
      triggerId: 'trigger-remove-failed',
      status: 'FAILED',
      worktreeError: 'permission denied',
    },
  ]);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
  fsModule.rmSync(tempRoot, { recursive: true, force: true });
});

test('startPolling acks and runs restart when meta.restartRequested is true with no pending trigger', async () => {
  let ackCalled = 0;
  let restartCalled = 0;
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () =>
          pollState({}, { cliLatestVersion: null, runnerLatestVersion: null, restartRequested: true }),
        ackRestartRequest: async () => {
          ackCalled += 1;
        },
      }),
    runCleanup: async () => undefined,
    maybeAutoUpdate: async () => {
      throw new Error('auto-update must be skipped while restarting');
    },
    executeRestartRequest: () => {
      restartCalled += 1;
    },
    setInterval: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ackCalled, 1, 'ackRestartRequest should be called exactly once');
  assert.equal(restartCalled, 1, 'executeRestartRequest should be called exactly once');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling restarts even when a pending trigger is present, ignoring the trigger', async () => {
  let ackCalled = 0;
  let restartCalled = 0;
  let claimCalled = 0;
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(
    config,
    () => async () => {
      throw new Error('trigger handler must not run when restart wins');
    },
    {
      createClient: () =>
        makeClient({
          fetchPollState: async () =>
            pollState(
              { pendingTrigger: trigger },
              { cliLatestVersion: null, runnerLatestVersion: null, restartRequested: true },
            ),
          claimTrigger: async () => {
            claimCalled += 1;
            return { ok: true, conflict: false };
          },
          ackRestartRequest: async () => {
            ackCalled += 1;
          },
        }),
      runCleanup: async () => undefined,
      executeRestartRequest: () => {
        restartCalled += 1;
      },
      setInterval: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
      processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
      processExit: (() => undefined as never) as (code: number) => never,
      now: () => 0,
      loadAuthPaths: () => [],
      saveAuthPath: () => '/tmp/auth-paths.json',
      keepAlive: () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ackCalled, 1, 'ack should run before restart');
  assert.equal(restartCalled, 1, 'restart should run even with a pending trigger');
  assert.equal(claimCalled, 0, 'trigger must not be claimed while restarting');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling skips restart and leaves the flag for retry when ack fails', async () => {
  let restartCalled = 0;
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () =>
          pollState({}, { cliLatestVersion: null, runnerLatestVersion: null, restartRequested: true }),
        ackRestartRequest: async () => {
          throw new Error('network down');
        },
      }),
    runCleanup: async () => undefined,
    executeRestartRequest: () => {
      restartCalled += 1;
    },
    setInterval: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => '/tmp/auth-paths.json',
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restartCalled, 0, 'restart must not run when ack fails');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling acquires the power save blocker on start and releases it on shutdown', async () => {
  const { events, blocker } = createRecordingBlocker();
  const signals = new Map<string, () => void>();
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
    runCleanup: async () => undefined,
    setInterval: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: ((event: NodeJS.Signals, listener: () => void) => {
      signals.set(event, listener);
    }) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => '/tmp/auth-paths.json',
    powerSaveBlocker: blocker,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['acquire:daemon-polling'], 'blocker should be acquired exactly once on start');

  const sigterm = signals.get('SIGTERM');
  assert.ok(sigterm);
  sigterm();
  assert.deepEqual(
    events,
    ['acquire:daemon-polling', 'release:daemon-polling'],
    'blocker should be released on shutdown',
  );

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling releases the power save blocker when keepAlive resolves', async () => {
  const { events, blocker } = createRecordingBlocker();
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
    runCleanup: async () => undefined,
    setInterval: (() => ({}) as NodeJS.Timeout) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
    now: () => 0,
    loadAuthPaths: () => [],
    saveAuthPath: () => '/tmp/auth-paths.json',
    powerSaveBlocker: blocker,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['acquire:daemon-polling']);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;

  assert.deepEqual(
    events,
    ['acquire:daemon-polling', 'release:daemon-polling'],
    'blocker should be released after keepAlive resolves',
  );
});
