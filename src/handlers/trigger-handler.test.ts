import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { createTriggerHandler } from './trigger-handler.js';
import { startPolling } from '../poller.js';
import type { ConventionMeta, DaemonTrigger, TriggerRuntime } from '../types.js';
import type { RunResult, Runner } from '../runners/types.js';
import { computeLocalKey } from '../utils/worktree-discovery.js';

const trigger: DaemonTrigger = {
  id: 'trigger-1',
  prompt: 'Implement feature',
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
  parentTriggerId: 'parent-1',
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

const runtime: TriggerRuntime = {
  triggerId: 'trigger-1',
  agentConfigId: 'agent-1',
  authPath: '/auth/path',
  apiKey: 'api-key',
  teamId: 'team-1',
  projectId: 'project-1',
  runnerPrompt:
    'API runner prompt\n- History path: {{AGENTRUNNER_CURRENT_HISTORY_PATH}}\n- Previous history path: {{AGENTRUNNER_PARENT_HISTORY_PATH}}',
  parentHistoryMarkdown: null,
  useWorktree: false,
  baseBranch: null,
  worktreeId: null,
};

test.afterEach(() => {
  mock.restoreAll();
});

test('createTriggerHandler runs the runner, reports history, and marks success', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const logEntries: Array<{ level: string; message: string }> = [];
  const discoveredAuthPaths: string[] = [];
  const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];

  const client = {
    fetchTriggerRuntime: async (...args: unknown[]) => {
      clientCalls.push({ method: 'fetchTriggerRuntime', args });
      return runtime;
    },
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: 'isTriggerCancelRequested', args });
      return false;
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const runner: Runner = {
    run: async (input) => {
      runnerInputs.push({ prompt: input.prompt, authPath: input.authPath });
      input.onStdoutChunk?.('stdout');
      input.onStderrChunk?.('stderr');
      return { exitCode: 0 };
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
      onAuthPathDiscovered: (authPath) => {
        discoveredAuthPaths.push(authPath);
      },
    },
    {
      createRunnerFactory: () => () => runner,
      createLogReporter: () => ({
        start: () => {
          logEntries.push({ level: 'START', message: 'started' });
        },
        append: (level, message) => {
          logEntries.push({ level, message });
        },
        stop: async () => {
          logEntries.push({ level: 'STOP', message: 'stopped' });
        },
      }),
      readHistoryFile: async () => '### Summary\n- done\n',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/auth/path/.agentteams/runner/history/parent-1.md',
      }),
    },
  );

  await handler(trigger);

  assert.deepEqual(discoveredAuthPaths, ['/auth/path']);
  assert.equal(runnerInputs.length, 1);
  assert.equal(
    runnerInputs[0]?.prompt,
    'API runner prompt\n- History path: /auth/path/.agentteams/runner/history/trigger-1.md\n- Previous history path: /auth/path/.agentteams/runner/history/parent-1.md',
  );
  assert.equal(
    logEntries.some((entry) => entry.level === 'INFO' && entry.message.includes('stdout')),
    true,
  );
  assert.equal(
    logEntries.some((entry) => entry.level === 'WARN' && entry.message.includes('stderr')),
    true,
  );
  assert.deepEqual(
    clientCalls.map((entry) => entry.method),
    ['fetchTriggerRuntime', 'isTriggerCancelRequested', 'updateTriggerHistory', 'updateTriggerStatus'],
  );
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'DONE', undefined]);
});

test('createTriggerHandler reuses a discovered worktree without managed create/remove lifecycle', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const runnerInputs: Array<{ authPath: string | null }> = [];
  let createWorktreeCalls = 0;

  const discoveredRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    repositoryRemoteUrl: 'https://example.com/acme/repo.git',
    discoveredWorktreeLocalKey: computeLocalKey('/discovered/wt'),
  };

  const client = {
    fetchTriggerRuntime: async () => discoveredRuntime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
    reportWorktreeStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'reportWorktreeStatus', args });
    },
  };

  const runner: Runner = {
    run: async (input) => {
      runnerInputs.push({ authPath: input.authPath });
      return { exitCode: 0 };
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => runner,
      createLogReporter: () => ({ start: () => {}, append: () => {}, stop: async () => {} }),
      readHistoryFile: async () => '### Summary\n- done\n',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/discovered/wt/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/discovered/wt/.agentteams/runner/history/parent-1.md',
      }),
      resolveDiscoveredWorktreePath: () => '/discovered/wt',
      pathExists: () => true,
      isGitRepo: () => true,
      realpath: (path) => path,
      resolveRepositoryOrigin: () => 'example.com/acme/repo',
      createWorktree: () => {
        createWorktreeCalls += 1;
        return '/should/not/be/called';
      },
    },
  );

  await handler(trigger);

  // discovered 실행은 managed worktree 생성/제거 lifecycle을 타지 않는다.
  assert.equal(createWorktreeCalls, 0);
  // runner cwd는 매핑된 discovered 경로.
  assert.equal(runnerInputs[0]?.authPath, '/discovered/wt');
  // managed worktree 상태(reportWorktreeStatus)는 호출되지 않는다(외부 소유권 보존).
  assert.equal(
    clientCalls.some((c) => c.method === 'reportWorktreeStatus'),
    false,
  );
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'DONE', undefined]);
});

test('createTriggerHandler rejects a reused path whose repository origin no longer matches runtime identity', async () => {
  let runnerRan = false;
  const statusCalls: unknown[][] = [];
  const discoveredRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    repositoryRemoteUrl: 'https://example.com/expected/repo.git',
    discoveredWorktreeLocalKey: computeLocalKey('/discovered/reused'),
  };
  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: {
        fetchTriggerRuntime: async () => discoveredRuntime,
        isTriggerCancelRequested: async () => false,
        updateTriggerHistory: async () => undefined,
        updateTriggerStatus: async (...args: unknown[]) => {
          statusCalls.push(args);
        },
      } as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => {
          runnerRan = true;
          return { exitCode: 0 };
        },
      }),
      createLogReporter: () => ({ start: () => {}, append: () => {}, stop: async () => {} }),
      resolveDiscoveredWorktreePath: () => '/discovered/reused',
      realpath: (path) => path,
      pathExists: () => true,
      isGitRepo: () => true,
      resolveRepositoryOrigin: () => 'example.com/other/repo',
      readHistoryFile: async () => '',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/discovered/reused/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });
  assert.equal(runnerRan, false);
  assert.equal(statusCalls.at(-1)?.[1], 'FAILED');
});

test('createTriggerHandler fails before starting the runner when a discovered worktree is missing', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  let runnerRan = false;
  let createWorktreeCalls = 0;

  const discoveredRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    discoveredWorktreeLocalKey: 'gone-key',
  };

  const client = {
    fetchTriggerRuntime: async () => discoveredRuntime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const runner: Runner = {
    run: async () => {
      runnerRan = true;
      return { exitCode: 0 };
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => runner,
      createLogReporter: () => ({ start: () => {}, append: () => {}, stop: async () => {} }),
      resolveDiscoveredWorktreePath: () => null, // 매핑 부재 → MISSING
      pathExists: () => false,
      isGitRepo: () => false,
      createWorktree: () => {
        createWorktreeCalls += 1;
        return '/should/not/be/called';
      },
    },
  );

  await handler(trigger);

  // Runner CLI를 시작하지 않고, managed 생성도 하지 않으며, FAILED로 보고한다.
  assert.equal(runnerRan, false);
  assert.equal(createWorktreeCalls, 0);
  const lastStatus = clientCalls.filter((c) => c.method === 'updateTriggerStatus').at(-1);
  assert.equal((lastStatus?.args as unknown[])[1], 'FAILED');
});

test('createTriggerHandler preserves the local history file and still marks success when history upload fails', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writeHistoryCalls: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
      // 서버가 보고를 거부하는 상황(예: 공유 러너 404, 일시적 네트워크 오류)을 모사.
      throw new Error('Failed to update trigger history (404)');
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0, outputText: '{"type":"result"}' }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      // 러너가 정상 히스토리 파일을 작성한 상태(Questions 섹션 포함 → 정규화 없음).
      readHistoryFile: async () => '### Summary\n- done\n\n### Questions for User\nNone',
      writeHistoryFile: async (path, content) => {
        writeHistoryCalls.push({ path, content });
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler(trigger);

  // 업로드는 1회 시도됐고(실패), 핵심: 좋은 히스토리 파일을 stdout 폴백으로 덮어쓰지 않는다.
  assert.equal(clientCalls.filter((entry) => entry.method === 'updateTriggerHistory').length, 1);
  assert.deepEqual(writeHistoryCalls, []);
  // 업로드 실패가 러너 성공을 뒤집지 않고 DONE으로 보고된다(FAILED 아님).
  const statusCall = clientCalls.find((entry) => entry.method === 'updateTriggerStatus');
  assert.deepEqual(statusCall?.args, ['trigger-1', 'DONE', undefined]);
});

test('createTriggerHandler flags NEEDS_REVIEW when the runner exits 0 without writing a history file', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writeHistoryCalls: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0, outputText: 'The final summary.' }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      // 러너가 필수 히스토리 파일을 남기지 않은 상태(파일 없음 → 읽기 실패).
      readHistoryFile: async () => {
        throw new Error('ENOENT: no such file');
      },
      writeHistoryFile: async (path, content) => {
        writeHistoryCalls.push({ path, content });
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler(trigger);

  // 캡처한 출력이 폴백 히스토리로 로컬 기록 + 서버 업로드되며, "completed successfully"라고 단정하지 않는다.
  assert.equal(writeHistoryCalls.length, 1);
  assert.match(writeHistoryCalls[0]?.content ?? '', /exited without writing the required history file/);
  const uploadCall = clientCalls.find((entry) => entry.method === 'updateTriggerHistory');
  assert.match(String(uploadCall?.args?.[1] ?? ''), /exited without writing the required history file/);
  // 핵심: exitCode 0이어도 산출물이 없으면 DONE이 아니라 NEEDS_REVIEW로 강등된다.
  const statusCall = clientCalls.find((entry) => entry.method === 'updateTriggerStatus');
  assert.deepEqual(statusCall?.args, ['trigger-1', 'NEEDS_REVIEW', undefined]);
});

test('createTriggerHandler strips a UTF-8 BOM before reporting history to the database', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const logEntries: Array<{ level: string; message: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0 }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: (level, message) => {
          logEntries.push({ level, message });
        },
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '\uFEFF### Summary\n- done\n',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/auth/path/.agentteams/runner/history/parent-1.md',
      }),
    },
  );

  await handler(trigger);

  // BOM stripped, and the missing Questions for User section is appended by normalization
  assert.deepEqual(clientCalls.at(0)?.args, ['trigger-1', '### Summary\n- done\n\n### Questions for User\nNone']);
  // observation signal: normalization is surfaced to the trigger log (web UI logs tab)
  assert.ok(logEntries.some((entry) => entry.level === 'WARN' && entry.message.includes('Questions for User')));
});

test('createTriggerHandler keeps history unchanged when the Questions for User section exists', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const logEntries: Array<{ level: string; message: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const historyWithQuestions = '### Summary\n- done\n\n### Questions for User\n- Should we ship this now?';

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0 }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: (level, message) => {
          logEntries.push({ level, message });
        },
        stop: async () => undefined,
      }),
      readHistoryFile: async () => historyWithQuestions,
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/auth/path/.agentteams/runner/history/parent-1.md',
      }),
    },
  );

  await handler(trigger);

  assert.deepEqual(clientCalls.at(0)?.args, ['trigger-1', historyWithQuestions]);
  // no normalization → no observation warning
  assert.ok(!logEntries.some((entry) => entry.message.includes('Questions for User')));
});

test('createTriggerHandler restores parent history from server-side coaction content', async () => {
  const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: '### Summary\n- restored from coaction\n',
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined,
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
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
      readHistoryFile: async (path) => {
        if (String(path).endsWith('parent-1.md')) {
          throw new Error('ENOENT');
        }
        return '### Summary\n- current\n';
      },
      writeHistoryFile: async (path, content) => {
        writtenFiles.push({ path, content });
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/auth/path/.agentteams/runner/history/parent-1.md',
      }),
    },
  );

  await handler(trigger);

  assert.equal(runnerInputs.length, 1);
  assert.deepEqual(writtenFiles, [
    {
      path: '/auth/path/.agentteams/runner/history/parent-1.md',
      content: '### Summary\n- restored from coaction',
    },
  ]);
});

test('createTriggerHandler strips a UTF-8 BOM before restoring parent history from the server', async () => {
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: '\uFEFF### Summary\n- restored from coaction\n',
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined,
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0 }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '### Summary\n- current\n',
      writeHistoryFile: async (path, content) => {
        writtenFiles.push({ path, content });
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/auth/path/.agentteams/runner/history/parent-1.md',
      }),
    },
  );

  await handler(trigger);

  assert.deepEqual(writtenFiles, [
    {
      path: '/auth/path/.agentteams/runner/history/parent-1.md',
      content: '### Summary\n- restored from coaction',
    },
  ]);
});

test('createTriggerHandler overwrites existing parent history with server cumulative context', async () => {
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      parentHistoryMarkdown: '### Summary\n- cumulative from server\n',
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined,
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0 }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '### Summary\n- stale local parent history\n',
      writeHistoryFile: async (path, content) => {
        writtenFiles.push({ path, content });
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: '/auth/path/.agentteams/runner/history/parent-1.md',
      }),
    },
  );

  await handler(trigger);

  assert.deepEqual(writtenFiles, [
    {
      path: '/auth/path/.agentteams/runner/history/parent-1.md',
      content: '### Summary\n- cumulative from server',
    },
  ]);
});

test('createTriggerHandler reports runner failures and falls back to last output', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 1, lastOutput: 'last output' }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'FAILED', 'last output']);
});

test('createTriggerHandler fails without running the runner when worktree creation fails', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const runnerInputs: Array<{ authPath: string | null }> = [];
  const worktreeRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    baseBranch: 'dev',
    worktreeId: 'worktree-1',
  };

  const client = {
    fetchTriggerRuntime: async () => worktreeRuntime,
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: 'isTriggerCancelRequested', args });
      return false;
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
    reportWorktreeStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'reportWorktreeStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ authPath: input.authPath });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      isGitRepo: () => true,
      createWorktree: () => {
        throw new Error('git worktree add failed');
      },
      readHistoryFile: async () => '',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, useWorktree: true, baseBranch: 'dev', worktreeId: 'worktree-1', parentTriggerId: null });

  assert.deepEqual(runnerInputs, []);
  assert.deepEqual(clientCalls.at(0)?.args, ['trigger-1', 'FAILED', 'git worktree add failed']);
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'FAILED', 'git worktree add failed']);
  assert.equal(
    clientCalls.some((entry) => entry.method === 'isTriggerCancelRequested'),
    false,
  );
});

test('createTriggerHandler fails without running the runner when worktree authPath is not a git repo', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const runnerInputs: Array<{ authPath: string | null }> = [];
  const worktreeRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    baseBranch: 'dev',
    worktreeId: 'worktree-1',
  };

  const client = {
    fetchTriggerRuntime: async () => worktreeRuntime,
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: 'isTriggerCancelRequested', args });
      return false;
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
    reportWorktreeStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'reportWorktreeStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ authPath: input.authPath });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      isGitRepo: () => false,
      readHistoryFile: async () => '',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, useWorktree: true, baseBranch: 'dev', worktreeId: 'worktree-1', parentTriggerId: null });

  assert.deepEqual(runnerInputs, []);
  assert.deepEqual(clientCalls.at(0)?.args, ['trigger-1', 'FAILED', 'Not a git repository: /auth/path']);
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'FAILED', 'Not a git repository: /auth/path']);
  assert.equal(
    clientCalls.some((entry) => entry.method === 'isTriggerCancelRequested'),
    false,
  );
});

test('createTriggerHandler resolves a member repo via remoteUrl when worktree authPath is not a git repo', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const runnerInputs: Array<{ authPath: string | null }> = [];
  const createWorktreeCalls: string[] = [];
  const resolveCalls: Array<{ authPath: string; remoteUrl: string | null }> = [];
  const discoveredAuthPaths: string[] = [];
  const worktreeRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    repositoryId: 'repo-1',
    repositoryRemoteUrl: 'https://github.com/rlarua/kma-ui.git',
    baseBranch: 'dev',
    worktreeId: 'worktree-1',
  };

  const client = {
    fetchTriggerRuntime: async () => worktreeRuntime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
    reportWorktreeStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'reportWorktreeStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
      onAuthPathDiscovered: (authPath) => {
        discoveredAuthPaths.push(authPath);
      },
    },
    {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ authPath: input.authPath });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      isGitRepo: () => false,
      resolveWorktreeAuthPath: (authPath, remoteUrl) => {
        resolveCalls.push({ authPath, remoteUrl });
        return { path: '/auth/path/kma-ui' };
      },
      createWorktree: (authPath) => {
        createWorktreeCalls.push(authPath);
        return '/auth/path/.kma-ui-worktrees/wt-worktree-1';
      },
      readHistoryFile: async () => '### Summary\n- done\n',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.kma-ui-worktrees/wt-worktree-1/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, useWorktree: true, baseBranch: 'dev', worktreeId: 'worktree-1', parentTriggerId: null });

  assert.deepEqual(resolveCalls, [{ authPath: '/auth/path', remoteUrl: 'https://github.com/rlarua/kma-ui.git' }]);
  // 제거 lifecycle 계약: poller가 worktree 제거 경로를 찾을 수 있도록
  // 해석된 멤버 repo 경로도 authPath로 등록되어야 한다.
  assert.deepEqual(discoveredAuthPaths, ['/auth/path', '/auth/path/kma-ui']);
  assert.deepEqual(createWorktreeCalls, ['/auth/path/kma-ui']);
  assert.deepEqual(runnerInputs, [{ authPath: '/auth/path/.kma-ui-worktrees/wt-worktree-1' }]);
  assert.deepEqual(clientCalls.find((entry) => entry.method === 'reportWorktreeStatus')?.args, ['trigger-1', 'ACTIVE']);
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'DONE', undefined]);
});

test('createTriggerHandler fails without running the runner when member repo resolution fails', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const runnerInputs: Array<{ authPath: string | null }> = [];
  const resolutionError =
    'Worktree requested but no member repository under /auth/path has an origin remote matching ' +
    'https://github.com/rlarua/kma-ui.git. Turn off the runner box (worktree) option and request the run again.';
  const worktreeRuntime: TriggerRuntime = {
    ...runtime,
    useWorktree: true,
    repositoryId: 'repo-1',
    repositoryRemoteUrl: 'https://github.com/rlarua/kma-ui.git',
    baseBranch: 'dev',
    worktreeId: 'worktree-1',
  };

  const client = {
    fetchTriggerRuntime: async () => worktreeRuntime,
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: 'isTriggerCancelRequested', args });
      return false;
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
    reportWorktreeStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'reportWorktreeStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ authPath: input.authPath });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      isGitRepo: () => false,
      resolveWorktreeAuthPath: () => ({ error: resolutionError }),
      readHistoryFile: async () => '',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, useWorktree: true, baseBranch: 'dev', worktreeId: 'worktree-1', parentTriggerId: null });

  assert.deepEqual(runnerInputs, []);
  assert.deepEqual(clientCalls.at(0)?.args, ['trigger-1', 'FAILED', resolutionError]);
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'FAILED', resolutionError]);
  assert.equal(
    clientCalls.some((entry) => entry.method === 'isTriggerCancelRequested'),
    false,
  );
});

// handler↔poller lifecycle 계약 테스트(실제 git): 비-git 루트에서 멤버 repo 해석으로
// 생성한 워크트리는 이후 REMOVE_REQUESTED 처리 시 실제 디렉터리와 worktree/* 브랜치가
// 삭제되어야 한다. 해석 경로가 authPath로 등록되지 않으면 poller가 경로를 못 찾은 채
// REMOVED로 보고하는 회귀를 막는다.
test('worktrees created via member repo resolution are removed by the poller lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-handler-lifecycle-'));
  try {
    // .invalid TLD는 DNS가 즉시 실패해 removeWorktree의 원격 브랜치 정리(ls-remote)가
    // 네트워크 대기 없이 스킵된다.
    const memberRepo = join(root, 'kma-ui');
    execFileSync('git', ['init', memberRepo], { stdio: 'pipe' });
    execFileSync('git', ['-C', memberRepo, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
    execFileSync('git', ['-C', memberRepo, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', memberRepo, 'commit', '--allow-empty', '-m', 'initial'], { stdio: 'pipe' });
    execFileSync('git', ['-C', memberRepo, 'remote', 'add', 'origin', 'git@git.invalid:team/kma-ui.git'], {
      stdio: 'pipe',
    });

    const discoveredAuthPaths: string[] = [];
    const handlerWorktreeReports: Array<{ triggerId: string; status: string }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: root,
        useWorktree: true,
        repositoryId: 'repo-1',
        repositoryRemoteUrl: 'https://git.invalid/team/kma-ui.git',
        baseBranch: null,
        worktreeId: 'lifecycle-1',
      }),
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
      reportWorktreeStatus: async (triggerId: string, status: string) => {
        handlerWorktreeReports.push({ triggerId, status });
      },
    };

    // isGitRepo/resolveWorktreeAuthPath/createWorktree는 주입하지 않는다 — 실제 구현이
    // 멤버 repo를 해석하고 진짜 git worktree를 만들어야 lifecycle이 검증된다.
    const handler = createTriggerHandler(
      {
        config: {
          daemonToken: 'daemon-token',
          apiUrl: 'https://api.example',
          pollingIntervalMs: 5000,
          maxPollingIntervalMs: 120_000,
          timeoutMs: 1500,
          idleTimeoutMs: 500,
          runnerCmd: 'opencode',
          preventSleepWhileBusy: false,
        },
        client: client as never,
        onAuthPathDiscovered: (authPath) => {
          discoveredAuthPaths.push(authPath);
        },
      },
      {
        createRunnerFactory: () => () => ({
          run: async () => ({ exitCode: 0 }) satisfies RunResult,
        }),
        createLogReporter: () => ({
          start: () => undefined,
          append: () => undefined,
          stop: async () => undefined,
        }),
        readHistoryFile: async () => '### Summary\n- done\n',
        resolveRunnerHistoryPaths: () => ({
          currentHistoryPath: join(root, 'history.md'),
          parentHistoryPath: null,
        }),
      },
    );

    await handler({
      ...trigger,
      useWorktree: true,
      baseBranch: null,
      worktreeId: 'lifecycle-1',
      parentTriggerId: null,
    });

    const worktreePath = join(root, '.kma-ui-worktrees', 'wt-lifecycle-1');
    assert.equal(existsSync(worktreePath), true);
    assert.equal(discoveredAuthPaths.includes(memberRepo), true);
    assert.deepEqual(handlerWorktreeReports, [{ triggerId: 'trigger-1', status: 'ACTIVE' }]);

    // 데몬 재시작 후 poller가 persist된 auth path들로 제거 요청을 처리하는 상황.
    const pollerReports: Array<{ triggerId: string; status: string; worktreeError?: string }> = [];
    const removalTrigger: DaemonTrigger = {
      ...trigger,
      id: 'trigger-1',
      useWorktree: true,
      worktreeId: 'lifecycle-1',
      worktreeStatus: 'REMOVE_REQUESTED',
      parentTriggerId: null,
    };

    let keepAliveResolve: (() => void) | null = null;
    const pollingPromise = startPolling(
      {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      () => async () => undefined,
      {
        createClient: () =>
          ({
            fetchPollState: async () => ({
              data: {
                orphanedCancelRequestedTriggerIds: [],
                pendingWorktreeRemovals: [removalTrigger],
                pendingTrigger: null,
              },
            }),
            claimTrigger: async () => ({ ok: true, conflict: false }),
            updateTriggerStatus: async () => undefined,
            reportWorktreeStatus: async (triggerId: string, status: string, worktreeError?: string) => {
              pollerReports.push({ triggerId, status, worktreeError });
            },
            notifyUpdate: async () => undefined,
            ackRestartRequest: async () => undefined,
          }) as never,
        runCleanup: async () => undefined,
        runConventionSync: async () => undefined,
        setTimeout: (() => ({ ref() {}, unref() {} }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
        clearTimeout: (() => undefined) as typeof clearTimeout,
        processOn: (() => undefined) as (event: NodeJS.Signals, listener: () => void) => void,
        processExit: (() => {
          throw new Error('should not exit');
        }) as (code: number) => never,
        now: () => 0,
        loadAuthPaths: () => [...discoveredAuthPaths],
        saveAuthPath: () => '/tmp/auth-paths.json',
        keepAlive: () =>
          new Promise<void>((resolve) => {
            keepAliveResolve = resolve;
          }),
      },
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(pollerReports, [{ triggerId: 'trigger-1', status: 'REMOVED', worktreeError: undefined }]);
    assert.equal(existsSync(worktreePath), false);
    const branches = execFileSync('git', ['-C', memberRepo, 'branch', '--list', 'worktree/lifecycle-1'], {
      encoding: 'utf8',
    });
    assert.equal(branches.trim(), '');

    const resolveKeepAlive =
      keepAliveResolve ??
      (() => {
        throw new Error('keepAlive resolver was not registered');
      });
    resolveKeepAlive();
    await pollingPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createTriggerHandler downgrades an idle-timeout to NEEDS_REVIEW when a history file was uploaded', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () =>
          ({
            exitCode: 1,
            idleTimedOut: true,
            lastOutput: 'idle',
            errorMessage: 'Runner idle timed out after 10m of no output',
          }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '### Summary\n- done\n\n### Questions for User\nNone',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  // 히스토리 파일이 업로드됐으므로 hard-FAIL이 아니라 NEEDS_REVIEW로 강등되고, 빨간 Error 배너가
  // 뜨지 않도록 errorMessage는 비운다.
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'NEEDS_REVIEW', undefined]);
});

test('createTriggerHandler keeps an idle-timeout as FAILED when no history file was produced', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        // idle 타임아웃이지만 히스토리 파일도, stdout 폴백도 없으면 작업 완료를 보장할 수 없어 FAILED 유지.
        run: async () =>
          ({
            exitCode: 1,
            idleTimedOut: true,
            lastOutput: 'idle',
            errorMessage: 'Runner idle timed out after 10m of no output',
          }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'FAILED', 'Runner idle timed out after 10m of no output']);
});

test('createTriggerHandler stores stdout as fallback history when the runner omits the history file', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () =>
          ({
            exitCode: 0,
            outputText: 'agentrunner version 0.0.11',
          }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      writeHistoryFile: async (path, content) => {
        writtenFiles.push({ path, content });
      },
      readHistoryFile: async () => {
        throw new Error('ENOENT');
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(
    clientCalls.map((entry) => entry.method),
    ['updateTriggerHistory', 'updateTriggerStatus'],
  );
  assert.equal(writtenFiles.length, 1);
  assert.equal(writtenFiles[0]?.path, '/auth/path/.agentteams/runner/history/trigger-1.md');
  assert.match(String(clientCalls[0]?.args[1]), /Agent output \(history file not written\)/);
  assert.match(String(clientCalls[0]?.args[1]), /agentrunner version 0\.0\.11/);
  // exitCode 0이라도 히스토리 파일이 없으면 DONE으로 단정하지 않고 NEEDS_REVIEW로 강등한다.
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'NEEDS_REVIEW', undefined]);
});

test('createTriggerHandler truncates long agent output in fallback history', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const longOutput = 'x'.repeat(9000);

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () =>
          ({
            exitCode: 0,
            outputText: longOutput,
          }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      writeHistoryFile: async (path, content) => {
        writtenFiles.push({ path, content });
      },
      readHistoryFile: async () => {
        throw new Error('ENOENT');
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  const fallbackContent = String(clientCalls[0]?.args[1]);
  assert.match(fallbackContent, /\*\(truncated\)\*/);
  assert.ok(fallbackContent.length < 9000, 'Fallback history should be truncated');
  assert.ok(
    fallbackContent.includes('x'.repeat(8000)),
    'Fallback history should retain output up to the 8,000 character limit',
  );
});

test('createTriggerHandler preserves fallback agent output within history limit', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const output = 'x'.repeat(8000);

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () =>
          ({
            exitCode: 0,
            outputText: output,
          }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      writeHistoryFile: async (path, content) => {
        writtenFiles.push({ path, content });
      },
      readHistoryFile: async () => {
        throw new Error('ENOENT');
      },
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  const fallbackContent = String(clientCalls[0]?.args[1]);
  assert.doesNotMatch(fallbackContent, /\*\(truncated\)\*/);
  assert.match(fallbackContent, new RegExp(`x{${output.length}}`));
});

test('createTriggerHandler cancels the runner when the server reports a cancel request', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async (...args: unknown[]) => {
      clientCalls.push({ method: 'isTriggerCancelRequested', args });
      return true;
    },
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
            if (signal?.aborted) {
              resolve();
            }
          });

          return {
            exitCode: 1,
            cancelled: true,
            errorMessage: 'Runner cancelled by user',
          } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '',
      cancelPollIntervalMs: 1,
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'CANCELLED', 'Runner cancelled by user']);
});

test('createTriggerHandler marks the trigger as failed when runtime loading throws', async () => {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, 'error', (message: string, meta?: Record<string, unknown>) => {
    errors.push({ message, meta });
  });

  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    fetchTriggerRuntime: async () => {
      throw new Error('runtime boom');
    },
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createLogReporter: () => ({
        start: () => undefined,
        append: () => undefined,
        stop: async () => undefined,
      }),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'FAILED', 'runtime boom']);
  assert.equal(
    errors.some((entry) => entry.message === 'Trigger handling failed'),
    true,
  );
});

// ---------------------------------------------------------------------------
// Pre-execution hook tests
// ---------------------------------------------------------------------------

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'trigger-handler-hook-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('createTriggerHandler passes the API-provided runner prompt unchanged', async () => {
  await withTempDir(async (dir) => {
    const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        runnerPrompt: 'Prompt generated by API\n\nDo exactly this.',
      }),
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler(
      {
        config: {
          daemonToken: 'daemon-token',
          apiUrl: 'https://api.example',
          pollingIntervalMs: 5000,
          maxPollingIntervalMs: 120_000,
          timeoutMs: 1500,
          idleTimeoutMs: 500,
          runnerCmd: 'opencode',
          preventSleepWhileBusy: false,
        },
        client: client as never,
      },
      {
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
        readHistoryFile: async () => '### Summary\n- done\n',
        resolveRunnerHistoryPaths: () => ({
          currentHistoryPath: join(dir, '.agentteams/runner/history/trigger-1.md'),
          parentHistoryPath: null,
        }),
      },
    );

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerInputs.length, 1);
    assert.equal(runnerInputs[0]?.prompt, 'Prompt generated by API\n\nDo exactly this.');
  });
});

test('createTriggerHandler downloads attachments into the runner workspace and injects local paths', async () => {
  await withTempDir(async (dir) => {
    const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
    const downloadedUrls: string[] = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        runnerPrompt: 'Use the attached file.',
        attachments: [
          {
            id: 'attachment-1',
            originalName: '../notes file.md',
            mimeType: 'text/markdown',
            size: 12,
            downloadUrl: 'https://storage.example/attachment-1',
            expiresInSeconds: 300,
          },
        ],
      }),
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler(
      {
        config: {
          daemonToken: 'daemon-token',
          apiUrl: 'https://api.example',
          pollingIntervalMs: 5000,
          maxPollingIntervalMs: 120_000,
          timeoutMs: 1500,
          idleTimeoutMs: 500,
          runnerCmd: 'opencode',
          preventSleepWhileBusy: false,
        },
        client: client as never,
      },
      {
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
        fetchAttachmentFile: async (downloadUrl) => {
          downloadedUrls.push(downloadUrl);
          return new TextEncoder().encode('hello world\n');
        },
        readHistoryFile: async () => '### Summary\n- done\n',
        resolveRunnerHistoryPaths: () => ({
          currentHistoryPath: join(dir, '.agentteams/runner/history/trigger-1.md'),
          parentHistoryPath: null,
        }),
      },
    );

    await handler({ ...trigger, parentTriggerId: null });

    assert.deepEqual(downloadedUrls, ['https://storage.example/attachment-1']);
    assert.equal(runnerInputs.length, 1);
    const prompt = runnerInputs[0]?.prompt ?? '';
    assert.match(prompt, /## Attached Files/);
    assert.match(prompt, /MIME type: text\/markdown/);
    assert.match(prompt, /Size: 12 bytes/);
    assert.match(prompt, /01-attachme-notes-file\.md/);
    assert.doesNotMatch(prompt, /https:\/\/storage\.example/);

    const localPathMatch = prompt.match(/Local path: (.+01-attachme-notes-file\.md)$/m);
    assert.ok(localPathMatch?.[1]);
    assert.equal(localPathMatch[1].startsWith(join(dir, '.agentteams', 'runner', 'attachments', 'trigger-1')), true);

    const attachmentDir = join(dir, '.agentteams', 'runner', 'attachments', 'trigger-1');
    await assert.rejects(stat(attachmentDir), /ENOENT/);
  });
});

test('createTriggerHandler removes the attachment directory after runner failure', async () => {
  await withTempDir(async (dir) => {
    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        runnerPrompt: 'Use the attached file.',
        attachments: [
          {
            id: 'attachment-1',
            originalName: 'notes.md',
            mimeType: 'text/markdown',
            size: 12,
            downloadUrl: 'https://storage.example/attachment-1',
            expiresInSeconds: 300,
          },
        ],
      }),
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler(
      {
        config: {
          daemonToken: 'daemon-token',
          apiUrl: 'https://api.example',
          pollingIntervalMs: 5000,
          maxPollingIntervalMs: 120_000,
          timeoutMs: 1500,
          idleTimeoutMs: 500,
          runnerCmd: 'opencode',
          preventSleepWhileBusy: false,
        },
        client: client as never,
      },
      {
        createRunnerFactory: () => () => ({
          run: async () => {
            throw new Error('runner crashed');
          },
        }),
        createLogReporter: () => ({
          start: () => undefined,
          append: () => undefined,
          stop: async () => undefined,
        }),
        fetchAttachmentFile: async () => new TextEncoder().encode('hello world\n'),
        readHistoryFile: async () => '',
        resolveRunnerHistoryPaths: () => ({
          currentHistoryPath: join(dir, '.agentteams/runner/history/trigger-1.md'),
          parentHistoryPath: null,
        }),
      },
    );

    await handler({ ...trigger, parentTriggerId: null });

    const attachmentDir = join(dir, '.agentteams', 'runner', 'attachments', 'trigger-1');
    await assert.rejects(stat(attachmentDir), /ENOENT/);
  });
});

test('createTriggerHandler logs but does not throw when attachment cleanup fails', async () => {
  await withTempDir(async (dir) => {
    const cleanupCalls: string[] = [];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        runnerPrompt: 'Use the attached file.',
        attachments: [
          {
            id: 'attachment-1',
            originalName: 'notes.md',
            mimeType: 'text/markdown',
            size: 12,
            downloadUrl: 'https://storage.example/attachment-1',
            expiresInSeconds: 300,
          },
        ],
      }),
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler(
      {
        config: {
          daemonToken: 'daemon-token',
          apiUrl: 'https://api.example',
          pollingIntervalMs: 5000,
          maxPollingIntervalMs: 120_000,
          timeoutMs: 1500,
          idleTimeoutMs: 500,
          runnerCmd: 'opencode',
          preventSleepWhileBusy: false,
        },
        client: client as never,
      },
      {
        createRunnerFactory: () => () => ({
          run: async () => ({ exitCode: 0 }) satisfies RunResult,
        }),
        createLogReporter: () => ({
          start: () => undefined,
          append: () => undefined,
          stop: async () => undefined,
        }),
        fetchAttachmentFile: async () => new TextEncoder().encode('hello world\n'),
        removeAttachmentDirectory: async (path) => {
          cleanupCalls.push(path);
          throw new Error('cleanup boom');
        },
        readHistoryFile: async () => '### Summary\n- done\n',
        resolveRunnerHistoryPaths: () => ({
          currentHistoryPath: join(dir, '.agentteams/runner/history/trigger-1.md'),
          parentHistoryPath: null,
        }),
      },
    );

    await handler({ ...trigger, parentTriggerId: null });

    assert.deepEqual(cleanupCalls, [join(dir, '.agentteams', 'runner', 'attachments', 'trigger-1')]);
  });
});

test('createTriggerHandler fails before runner execution when attachments have no runner workspace', async () => {
  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  let runnerCalled = false;
  const client = {
    fetchTriggerRuntime: async () => ({
      ...runtime,
      authPath: null,
      attachments: [
        {
          id: 'attachment-1',
          originalName: 'notes.md',
          mimeType: 'text/markdown',
          size: 12,
          downloadUrl: 'https://storage.example/attachment-1',
          expiresInSeconds: 300,
        },
      ],
    }),
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerHistory', args });
    },
    updateTriggerStatus: async (...args: unknown[]) => {
      clientCalls.push({ method: 'updateTriggerStatus', args });
    },
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
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
      fetchAttachmentFile: async () => new Uint8Array(),
    },
  );

  await handler({ ...trigger, parentTriggerId: null });

  assert.equal(runnerCalled, false);
  assert.deepEqual(clientCalls.at(-1)?.args, [
    'trigger-1',
    'FAILED',
    'Cannot deliver attachments because runner workspace path is not configured.',
  ]);
});

test('createTriggerHandler does not append history or convention text to the API prompt', async () => {
  await withTempDir(async (dir) => {
    const runnerInputs: Array<{ prompt: string; authPath: string | null }> = [];
    const conventions: ConventionMeta[] = [
      {
        id: 'conv-feature',
        filePath: '.agentteams/rules/feature.md',
        trigger: 'task:FEATURE',
        title: 'Feature Convention',
        description: 'Rules for feature tasks',
      },
    ];

    const client = {
      fetchTriggerRuntime: async () => ({
        ...runtime,
        authPath: dir,
        conventions,
        planType: 'BUG_FIX',
        runnerPrompt: 'Only the API prompt',
      }),
      isTriggerCancelRequested: async () => false,
      updateTriggerHistory: async () => undefined,
      updateTriggerStatus: async () => undefined,
    };

    const handler = createTriggerHandler(
      {
        config: {
          daemonToken: 'daemon-token',
          apiUrl: 'https://api.example',
          pollingIntervalMs: 5000,
          maxPollingIntervalMs: 120_000,
          timeoutMs: 1500,
          idleTimeoutMs: 500,
          runnerCmd: 'opencode',
          preventSleepWhileBusy: false,
        },
        client: client as never,
      },
      {
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
        readHistoryFile: async () => '### Summary\n- done\n',
        resolveRunnerHistoryPaths: () => ({
          currentHistoryPath: join(dir, '.agentteams/runner/history/trigger-1.md'),
          parentHistoryPath: null,
        }),
      },
    );

    await handler({ ...trigger, parentTriggerId: null });

    assert.equal(runnerInputs.length, 1);
    assert.equal(runnerInputs[0]?.prompt, 'Only the API prompt');
    assert.doesNotMatch(runnerInputs[0]?.prompt ?? '', /Context-Matched Conventions \(AUTO-LOADED\)/);
  });
});

test('createTriggerHandler surfaces a user-visible warning when the runner ignores model/fastMode', async () => {
  const logEntries: Array<{ level: string; message: string }> = [];
  const runnerInputs: Array<{ model: string | null | undefined; fastMode: boolean | undefined }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined,
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async (input) => {
          runnerInputs.push({ model: input.model, fastMode: input.fastMode });
          return { exitCode: 0 } satisfies RunResult;
        },
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: (level, message) => {
          logEntries.push({ level, message });
        },
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '### Summary\n- done\n',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  // ANTIGRAVITY는 model을 --model로 소비하지만 fastMode는 지원하지 않는다.
  await handler({ ...trigger, runnerType: 'ANTIGRAVITY', model: 'gemini-3', fastMode: true });

  const warnings = logEntries.filter((entry) => entry.level === 'WARN');
  assert.equal(
    warnings.some((w) => /Model selection is not supported by runner ANTIGRAVITY/.test(w.message)),
    false,
  );
  assert.equal(
    warnings.some((w) => /Fast mode is not supported by runner ANTIGRAVITY/.test(w.message)),
    true,
  );
  assert.equal(runnerInputs[0]?.model, 'gemini-3');
  // 미지원 fastMode는 러너로 전달되지 않는다(현행 gating 유지).
  assert.equal(runnerInputs[0]?.fastMode, false);
});

test('createTriggerHandler does not warn when the runner supports the requested options', async () => {
  const logEntries: Array<{ level: string; message: string }> = [];

  const client = {
    fetchTriggerRuntime: async () => runtime,
    isTriggerCancelRequested: async () => false,
    updateTriggerHistory: async () => undefined,
    updateTriggerStatus: async () => undefined,
  };

  const handler = createTriggerHandler(
    {
      config: {
        daemonToken: 'daemon-token',
        apiUrl: 'https://api.example',
        pollingIntervalMs: 5000,
        maxPollingIntervalMs: 120_000,
        timeoutMs: 1500,
        idleTimeoutMs: 500,
        runnerCmd: 'opencode',
        preventSleepWhileBusy: false,
      },
      client: client as never,
    },
    {
      createRunnerFactory: () => () => ({
        run: async () => ({ exitCode: 0 }) satisfies RunResult,
      }),
      createLogReporter: () => ({
        start: () => undefined,
        append: (level, message) => {
          logEntries.push({ level, message });
        },
        stop: async () => undefined,
      }),
      readHistoryFile: async () => '### Summary\n- done\n',
      resolveRunnerHistoryPaths: () => ({
        currentHistoryPath: '/auth/path/.agentteams/runner/history/trigger-1.md',
        parentHistoryPath: null,
      }),
    },
  );

  await handler({ ...trigger, runnerType: 'CODEX', model: 'o4-mini', fastMode: true });

  const unsupportedWarnings = logEntries.filter(
    (entry) => entry.level === 'WARN' && /is not supported by runner/.test(entry.message),
  );
  assert.deepEqual(unsupportedWarnings, []);
});
