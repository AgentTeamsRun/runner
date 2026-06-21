import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { createTriggerHandler } from './trigger-handler.js';
import type { ConventionMeta, DaemonTrigger, TriggerRuntime } from '../types.js';
import type { RunResult, Runner } from '../runners/types.js';

const trigger: DaemonTrigger = {
  id: 'trigger-1',
  prompt: 'Implement feature',
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
  assert.deepEqual(clientCalls.at(-1)?.args, ['trigger-1', 'DONE', undefined]);
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
