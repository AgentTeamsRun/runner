import assert from 'node:assert/strict';
import * as fsModule from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { logger } from './logger.js';
import { MAX_REPORTED_MODEL_VALUES_PER_RUNNER, startPolling } from './poller.js';
import type { DaemonTrigger, PollStateResponse, RuntimeConfig } from './types.js';
import type { EnumeratedModel } from './utils/model-enumerator.js';

const config: RuntimeConfig = {
  daemonToken: 'daemon-token',
  apiUrl: 'https://api.example',
  pollingIntervalMs: 5000,
  maxPollingIntervalMs: 12_000,
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
  effort: null,
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
  reportDetectedEngines?: (engines: string[]) => Promise<void>;
  reportDetectedModels?: (models: Array<{ runnerType: string; values: EnumeratedModel[] }>) => Promise<void>;
};

// 기본은 idle(아무 작업 없음) 러너 클라이언트. 필요한 동작만 override한다.
const makeClient = (overrides: PollClientOverrides = {}) => ({
  fetchPollState: overrides.fetchPollState ?? (async () => pollState()),
  claimTrigger: overrides.claimTrigger ?? (async () => ({ ok: true, conflict: false })),
  updateTriggerStatus: overrides.updateTriggerStatus ?? (async () => undefined),
  reportWorktreeStatus: overrides.reportWorktreeStatus ?? (async () => undefined),
  notifyUpdate: overrides.notifyUpdate ?? (async () => undefined),
  ackRestartRequest: overrides.ackRestartRequest ?? (async () => undefined),
  ...(overrides.reportDetectedEngines ? { reportDetectedEngines: overrides.reportDetectedEngines } : {}),
  ...(overrides.reportDetectedModels ? { reportDetectedModels: overrides.reportDetectedModels } : {}),
});

test('startPolling enumerates only installed supported engines and respects the longer interval', async () => {
  const timeouts = createTimeoutRecorder();
  const enumerationCalls: string[] = [];
  const reports: Array<Array<{ runnerType: string; values: EnumeratedModel[] }>> = [];
  const warnings: string[] = [];
  mock.method(logger, 'warn', (message: string) => warnings.push(message));
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        reportDetectedEngines: async () => undefined,
        reportDetectedModels: async (models) => {
          reports.push(models);
        },
      }),
    probeInstalledEngines: async () => ({
      engines: ['KIRO_CLI', 'CURSOR_CLI', 'CODEX'],
      reliable: true,
    }),
    enumerateModels: async (runnerType) => {
      enumerationCalls.push(runnerType);
      if (runnerType === 'CURSOR_CLI') return { status: 'FORMAT_MISMATCH' };
      return {
        status: 'SUCCESS',
        values: [{ value: 'model-a', label: 'Model A', maxInputTokens: 200000 }],
      };
    },
    runCleanup: async () => undefined,
    runConventionSync: async () => undefined,
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => 0,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(enumerationCalls, ['KIRO_CLI', 'CURSOR_CLI', 'CODEX']);
  assert.deepEqual(reports, [
    [
      {
        runnerType: 'KIRO_CLI',
        values: [{ value: 'model-a', label: 'Model A', maxInputTokens: 200000 }],
      },
      {
        runnerType: 'CODEX',
        values: [{ value: 'model-a', label: 'Model A', maxInputTokens: 200000 }],
      },
    ],
  ]);
  assert.ok(warnings.includes('Skipped model detection report for runner'));
  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

// 열거가 탐지·기동과 다른 실행 파일을 보면 RUNNER_CMD를 바꾼 환경에서 열거만 조용히 실패한다.
test('startPolling enumerates OpenCode models with the configured runner command', async () => {
  const timeouts = createTimeoutRecorder();
  const enumeratedCommands: Array<string | undefined> = [];
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling({ ...config, runnerCmd: 'custom-opencode' }, () => async () => undefined, {
    createClient: () =>
      makeClient({
        reportDetectedEngines: async () => undefined,
        reportDetectedModels: async () => undefined,
      }),
    probeInstalledEngines: async () => ({ engines: ['OPENCODE'], reliable: true }),
    enumerateModels: async (_runnerType, _dependencies, opencodeCommand) => {
      enumeratedCommands.push(opencodeCommand);
      return { status: 'SUCCESS', values: [{ value: 'provider/model-a', label: 'provider/model-a' }] };
    },
    runCleanup: async () => undefined,
    runConventionSync: async () => undefined,
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => 0,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(enumeratedCommands, ['custom-opencode']);
  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

test('startPolling keeps polling when the model report fails', async () => {
  const warnings: string[] = [];
  mock.method(logger, 'warn', (message: string) => warnings.push(message));
  const timeouts = createTimeoutRecorder();
  let fetchCalls = 0;
  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => {
          fetchCalls += 1;
          return pollState();
        },
        reportDetectedEngines: async () => undefined,
        reportDetectedModels: async () => {
          throw new Error('offline');
        },
      }),
    probeInstalledEngines: async () => ({ engines: ['KIRO_CLI'], reliable: true }),
    enumerateModels: async () => ({
      status: 'SUCCESS',
      values: [{ value: 'auto', label: 'auto', maxInputTokens: 1000000 }],
    }),
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => 0,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls, 2);
  assert.ok(warnings.includes('Model detection report failed'));
  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

// Cursor CLI 실측(2026-08-16)이 엔진당 203 모델로 서버 values 상한을 넘으면서 보고 전체가 400으로
// 거절되는 사고(맥북에어 러너 모델 탐지 영구 실패)의 재현. 러너는 상한 초과 입력을 상한 이하로
// 결정적으로 잘라 전송해야 한다. 현재 코드에서는 600건이 그대로 넘어가 이 테스트는 실패한다.
test('startPolling truncates oversized per-engine model reports deterministically before sending', async () => {
  const timeouts = createTimeoutRecorder();
  const reports: Array<Array<{ runnerType: string; values: EnumeratedModel[] }>> = [];
  const warnings: Array<{ message: string; context?: unknown }> = [];
  mock.method(logger, 'warn', (message: string, context?: unknown) => warnings.push({ message, context }));
  let fakeNow = 0;
  let keepAliveResolve: (() => void) | null = null;

  // 열거 출력 순서는 CLI 출력 순서로 결정적이다. 절단도 같은 순서의 앞부분을 취해야 한다.
  const enumerated: EnumeratedModel[] = Array.from({ length: 600 }, (_, index) => ({
    value: `cursor-${String(index + 1).padStart(3, '0')}`,
    label: `Cursor ${index + 1}`,
  }));

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        reportDetectedEngines: async () => undefined,
        reportDetectedModels: async (models) => {
          reports.push(models);
        },
      }),
    probeInstalledEngines: async () => ({ engines: ['CURSOR_CLI'], reliable: true }),
    enumerateModels: async () => ({ status: 'SUCCESS', values: enumerated }),
    runCleanup: async () => undefined,
    runConventionSync: async () => undefined,
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => fakeNow,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  const sentValues = reports[0]![0]!.values;
  assert.ok(
    sentValues.length < enumerated.length,
    `oversized enumeration must be truncated before reporting (sent ${sentValues.length})`,
  );
  assert.equal(sentValues.length, MAX_REPORTED_MODEL_VALUES_PER_RUNNER);
  // 절단은 앞부분을 취하는 결정적 절단이어야 한다 — 같은 입력이면 같은 부분집합.
  assert.deepEqual(sentValues, enumerated.slice(0, sentValues.length));

  // 조용한 절단은 금지다. 무엇이 몇 건 잘렸는지 runnerType와 함께 남는다.
  const truncationWarning = warnings.find((entry) => entry.message.toLowerCase().includes('truncat'));
  assert.ok(truncationWarning, 'truncation must leave a warning');
  const truncationContext = truncationWarning!.context as { runnerType?: string; droppedCount?: number } | undefined;
  assert.equal(truncationContext?.runnerType, 'CURSOR_CLI');
  assert.equal(truncationContext?.droppedCount, enumerated.length - sentValues.length);

  // 다음 탐지 주기에도 같은 입력이면 동일한 부분집합을 보낸다.
  fakeNow += 7 * 60 * 60 * 1000;
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1]![0]!.values, sentValues);

  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

// daemon은 서브트리 배포·zero-dependency라 api 스키마 상수를 런타임 import할 수 없다. 미러 상수가
// SSOT(api/src/schemas/daemon.ts)와 어긋나면 서버가 보고 전체를 400으로 거절하는 사고가 재발하므로
// SSOT 선언을 읽어 대조한다(cli/test/runner-types.test.ts 선례). 모노레포에서만 실행 가능한 테스트다.
test('MAX_REPORTED_MODEL_VALUES_PER_RUNNER mirrors the api schema SSOT', () => {
  const schemaPath = path.join(process.cwd(), '..', 'api', 'src', 'schemas', 'daemon.ts');
  assert.ok(fsModule.existsSync(schemaPath), `api schema source must exist in the monorepo: ${schemaPath}`);
  const source = fsModule.readFileSync(schemaPath, 'utf-8');
  const declaration = /export const MAX_REPORTED_MODEL_VALUES_PER_RUNNER = (\d+);/.exec(source);
  assert.ok(declaration, 'SSOT declaration for the per-runner values cap must exist');
  assert.equal(
    MAX_REPORTED_MODEL_VALUES_PER_RUNNER,
    Number(declaration![1]),
    'daemon mirror must match the api schema SSOT',
  );
});

test('startPolling reports detected engines immediately and does not probe again inside the interval', async () => {
  const timeouts = createTimeoutRecorder();
  const reports: string[][] = [];
  let probeCalls = 0;
  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        reportDetectedEngines: async (engines) => {
          reports.push(engines);
        },
      }),
    probeInstalledEngines: async () => {
      probeCalls += 1;
      return { engines: ['CODEX'], reliable: true };
    },
    runCleanup: async () => undefined,
    runConventionSync: async () => undefined,
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => 0,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(probeCalls, 1);
  assert.deepEqual(reports, [['CODEX']]);
  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

test('startPolling keeps polling when the engine report fails', async () => {
  const warnings: string[] = [];
  mock.method(logger, 'warn', (message: string) => warnings.push(message));
  let fetchCalls = 0;
  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => {
          fetchCalls += 1;
          return pollState();
        },
        reportDetectedEngines: async () => {
          throw new Error('offline');
        },
      }),
    probeInstalledEngines: async () => ({ engines: ['CODEX'], reliable: true }),
    setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => 0,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  assert.ok(warnings.includes('Engine detection report failed'));
  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

// 빈 목록은 서버에서 "제한 없음"으로 해석되므로, 신뢰할 수 없는 탐지는 보고 자체를 건너뛰어야 한다.
test('startPolling skips the engine report when the probe is unreliable', async () => {
  const warnings: string[] = [];
  mock.method(logger, 'warn', (message: string) => warnings.push(message));
  const reports: string[][] = [];
  let keepAliveResolve: (() => void) | null = null;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        reportDetectedEngines: async (engines) => {
          reports.push(engines);
        },
      }),
    probeInstalledEngines: async () => ({ engines: [], reliable: false }),
    setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
    now: () => 0,
    keepAlive: () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, []);
  assert.ok(
    warnings.some((warning) => warning.startsWith('Skipped engine detection report')),
    'expected an explicit skip warning',
  );
  (keepAliveResolve as unknown as () => void)();
  await pollingPromise;
});

// setTimeout 주입 목: 예약된 폴 콜백과 delay를 캡처해 수동으로 구동한다.
// 자기예약 루프는 매 cycle 완료 후 새 timeout을 예약하므로, 다음 폴은 scheduled의
// 마지막 항목을 fire하면 된다.
const createTimeoutRecorder = () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const cleared: NodeJS.Timeout[] = [];
  const setTimeoutMock = ((callback: () => void, delayMs?: number) => {
    scheduled.push({ callback, delayMs: delayMs ?? 0 });
    return { ref() {}, unref() {} } as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutMock = ((handle: NodeJS.Timeout) => {
    cleared.push(handle);
  }) as typeof clearTimeout;
  return { scheduled, cleared, setTimeoutMock, clearTimeoutMock };
};

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
  const timeouts = createTimeoutRecorder();
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
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
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
  assert.equal(timeouts.scheduled.length, 1);
  // 부트스트랩 cycle에서 트리거를 처리했으므로 다음 폴은 base 간격으로 예약된다.
  assert.equal(timeouts.scheduled[0]?.delayMs, config.pollingIntervalMs);

  nowValue = 24 * 60 * 60 * 1000 + 1;
  timeouts.scheduled[0]?.callback();
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
      setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
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
  const timeouts = createTimeoutRecorder();
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
    setTimeout: timeouts.setTimeoutMock,
    clearTimeout: timeouts.clearTimeoutMock,
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
  assert.equal(timeouts.scheduled.length, 1);

  nowValue += 6 * 60 * 60 * 1000 - 1;
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(conventionSyncCalls, ['/auth/path']);

  nowValue += 1;
  timeouts.scheduled.at(-1)?.callback();
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

test('startPolling logs conflicts and suppresses overlapping polling cycles without double-scheduling', async () => {
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, 'info', (message: string, meta?: Record<string, unknown>) => {
    infos.push({ message, meta });
  });

  // 부트스트랩 cycle은 즉시 idle로 완료시키고, 두 번째 cycle의 fetch를 행 걸어
  // 그 사이 재진입(pollOnce 중복 호출)이 억제되는지 확인한다.
  let fetchCalls = 0;
  let releaseFetch: (() => void) | null = null;
  const client = makeClient({
    fetchPollState: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return pollState();
      }
      return await new Promise<PollStateResponse>((resolve) => {
        releaseFetch = () => resolve(pollState({ pendingTrigger: trigger }));
      });
    },
    claimTrigger: async () => ({ ok: false, conflict: true }),
  });

  const timeouts = createTimeoutRecorder();
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(
    config,
    () => async () => {
      throw new Error('handler should not run');
    },
    {
      createClient: () => client,
      runCleanup: async () => undefined,
      setTimeout: timeouts.setTimeoutMock,
      clearTimeout: timeouts.clearTimeoutMock,
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
  assert.equal(timeouts.scheduled.length, 1, 'bootstrap cycle should schedule the next poll');

  // 두 번째 cycle 시작(fetch 행) 후 같은 콜백을 한 번 더 fire → 재진입 억제.
  timeouts.scheduled[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled.length, 1, 'suppressed overlapping cycle must not schedule another poll');

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
  // 행 걸렸던 cycle이 완료되면서 다음 폴 1개만 예약되고, pending 트리거를 봤으므로 base 간격이다.
  assert.equal(timeouts.scheduled.length, 2, 'the in-flight cycle owns scheduling the next poll');
  assert.equal(timeouts.scheduled[1]?.delayMs, config.pollingIntervalMs);

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling clears the pending poll timer and exits on shutdown signals', async () => {
  const signals = new Map<string, () => void>();
  const cleared: NodeJS.Timeout[] = [];
  let keepAliveResolve: (() => void) | null = null;
  let exitCode: number | null = null;

  const timeoutHandle = {} as NodeJS.Timeout;
  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
    runCleanup: async () => undefined,
    setTimeout: (() => timeoutHandle) as unknown as typeof setTimeout,
    clearTimeout: ((handle: NodeJS.Timeout) => {
      cleared.push(handle);
    }) as typeof clearTimeout,
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
  assert.deepEqual(cleared, [timeoutHandle]);

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
    setTimeout: (() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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
    setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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
    setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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
    setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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

test('startPolling delegates acknowledgement and runtime config to the restart orchestrator', async () => {
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
    executeRestartRequest: async (deps) => {
      restartCalled += 1;
      assert.ok(deps);
      assert.equal(deps.config, config);
      await deps.acknowledgeRestart?.();
      return {
        status: 'acknowledged',
        handoffId: 'poller-restart',
        replacementReady: true,
        acknowledged: true,
        retryableFailure: false,
      };
    },
    setTimeout: (() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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
      executeRestartRequest: async (deps) => {
        restartCalled += 1;
        assert.ok(deps);
        await deps.acknowledgeRestart?.();
        return {
          status: 'acknowledged',
          handoffId: 'poller-restart',
          replacementReady: true,
          acknowledged: true,
          retryableFailure: false,
        };
      },
      setTimeout: (() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
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
  assert.equal(ackCalled, 1, 'the restart orchestrator should own acknowledgement');
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

test('startPolling leaves restart ownership with the orchestrator when acknowledgement fails', async () => {
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
          throw new Error('network down');
        },
      }),
    runCleanup: async () => undefined,
    executeRestartRequest: async (deps) => {
      restartCalled += 1;
      assert.ok(deps);
      try {
        await deps.acknowledgeRestart?.();
      } catch (error) {
        return {
          status: 'retryable-failure',
          handoffId: 'poller-restart',
          replacementReady: false,
          acknowledged: false,
          retryableFailure: true,
          reason: 'acknowledgement-failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        status: 'acknowledged',
        handoffId: 'poller-restart',
        replacementReady: true,
        acknowledged: true,
        retryableFailure: false,
      };
    },
    setTimeout: (() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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
  assert.equal(restartCalled, 1, 'restart orchestrator should receive every restart request');
  assert.equal(ackCalled, 1, 'acknowledgement should be attempted through the injected callback');

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
    setTimeout: (() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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
    setTimeout: (() => ({}) as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
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

// idle 백오프 테스트 공통 의존성. 폴 스케줄만 관찰하고 나머지는 no-op으로 둔다.
const backoffDependencies = (timeouts: ReturnType<typeof createTimeoutRecorder>, keepAlive: () => Promise<void>) => ({
  runCleanup: async () => undefined,
  runConventionSync: async () => undefined,
  maybeAutoUpdate: async () => ({ cliUpdated: false, runnerUpdated: false }),
  setTimeout: timeouts.setTimeoutMock,
  clearTimeout: timeouts.clearTimeoutMock,
  processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
  processExit: (() => {
    throw new Error('should not exit');
  }) as (code: number) => never,
  now: () => 0,
  loadAuthPaths: () => [],
  saveAuthPath: () => '/tmp/auth-paths.json',
  keepAlive,
});

test('startPolling schedules one next poll after fetchPollState rejects', async () => {
  const timeouts = createTimeoutRecorder();
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () =>
      makeClient({
        fetchPollState: async () => {
          throw new Error('network unavailable');
        },
      }),
    ...backoffDependencies(
      timeouts,
      () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    ),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled.length, 1);
  assert.equal(timeouts.scheduled[0]?.delayMs, 7500, 'failed idle cycle keeps the adaptive delay rule');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling backs off the poll interval while idle and clamps at maxPollingIntervalMs', async () => {
  const timeouts = createTimeoutRecorder();
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
    ...backoffDependencies(
      timeouts,
      () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    ),
  });

  // base 5000 / max 12000: idle 연속 시 5000×(1+n×0.5) → 7500, 10000, 12500→12000 clamp.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled.length, 1);
  assert.equal(timeouts.scheduled[0]?.delayMs, 7500);

  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled[1]?.delayMs, 10_000);

  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled[2]?.delayMs, 12_000, 'delay should clamp at maxPollingIntervalMs');

  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled[3]?.delayMs, 12_000, 'delay should stay clamped while idle continues');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling resets the poll interval to base after an active cycle', async () => {
  const timeouts = createTimeoutRecorder();
  let keepAliveResolve: (() => void) | null = null;

  // 폴 순서: idle → idle → pending 트리거(활동) → idle.
  const responses = [pollState(), pollState(), pollState({ pendingTrigger: trigger }), pollState()];
  const client = makeClient({
    fetchPollState: async () => responses.shift() ?? pollState(),
  });

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => client,
    ...backoffDependencies(
      timeouts,
      () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    ),
  });

  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  timeouts.scheduled.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    timeouts.scheduled.map((entry) => entry.delayMs),
    // idle 백오프(7500→10000) → 활동 시 base(5000) 리셋 → idle streak 처음부터(7500).
    [7500, 10_000, 5000, 7500],
  );

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});

test('startPolling stops scheduling new polls after shutdown', async () => {
  const timeouts = createTimeoutRecorder();
  const signals = new Map<string, () => void>();
  let keepAliveResolve: (() => void) | null = null;

  const pollingPromise = startPolling(config, () => async () => undefined, {
    createClient: () => makeClient(),
    ...backoffDependencies(
      timeouts,
      () =>
        new Promise<void>((resolve) => {
          keepAliveResolve = resolve;
        }),
    ),
    processOn: ((event: NodeJS.Signals, listener: () => void) => {
      signals.set(event, listener);
    }) as (event: NodeJS.Signals, listener: () => void) => void,
    processExit: (() => undefined as never) as (code: number) => never,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled.length, 1);

  const sigterm = signals.get('SIGTERM');
  assert.ok(sigterm);
  sigterm();
  assert.equal(timeouts.cleared.length, 1, 'pending poll timer should be cleared on shutdown');

  // 셧다운 이후 잔여 타이머 콜백이 fire되어도 새 폴을 예약하지 않는다.
  timeouts.scheduled[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.scheduled.length, 1, 'no new poll may be scheduled after shutdown');

  const resolveKeepAlive =
    keepAliveResolve ??
    (() => {
      throw new Error('keepAlive resolver was not registered');
    });
  resolveKeepAlive();
  await pollingPromise;
});
