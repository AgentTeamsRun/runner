import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { mock } from 'node:test';
import { DAEMON_API_TRANSPORT_TIMEOUT_MS, DaemonApiClient } from './api-client.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };
const runnerVersion = packageJson.version ?? '0.0.0';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  mock.restoreAll();
});

test('validateDaemonToken sends daemon header and returns payload data', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const expectedOsType =
    process.platform === 'darwin'
      ? 'MACOS'
      : process.platform === 'win32'
        ? 'WINDOWS'
        : process.platform === 'linux'
          ? 'LINUX'
          : undefined;

  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        data: {
          id: 'd1',
          memberId: 'm1',
          label: null,
          osType: 'MACOS',
          runnerVersion,
          supportedEngines: ['CODEX'],
          lastSeenAt: null,
          createdAt: 'c',
          updatedAt: 'u',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  const result = await client.validateDaemonToken();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.example/api/daemons/me');
  assert.deepEqual(
    calls[0]?.options?.headers,
    expectedOsType
      ? {
          'X-AgentTeams-Client': 'daemon',
          'x-daemon-token': 'daemon-token',
          'x-runner-version': runnerVersion,
          'x-os-type': expectedOsType,
        }
      : {
          'X-AgentTeams-Client': 'daemon',
          'x-daemon-token': 'daemon-token',
          'x-runner-version': runnerVersion,
        },
  );
  assert.equal(result.id, 'd1');
  assert.equal(result.osType, 'MACOS');
  assert.deepEqual(result.supportedEngines, ['CODEX']);
});

test('fetchPollState GETs the unified poll-state endpoint and returns the payload', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        data: {
          orphanedCancelRequestedTriggerIds: ['o1'],
          pendingWorktreeRemovals: [{ id: 'w1' }],
          pendingTrigger: { id: 'p1' },
        },
        meta: { cliLatestVersion: '1.2.3', runnerLatestVersion: '4.5.6', restartRequested: true },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  const result = await client.fetchPollState();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.example/api/daemon-triggers/poll-state');
  assert.equal((calls[0]?.options as RequestInit).method, 'GET');
  assert.equal((calls[0]?.options?.headers as Record<string, string>)['x-daemon-token'], 'daemon-token');
  assert.deepEqual(result.data.orphanedCancelRequestedTriggerIds, ['o1']);
  assert.equal(result.data.pendingWorktreeRemovals[0]?.id, 'w1');
  assert.equal(result.data.pendingTrigger?.id, 'p1');
  assert.equal(result.meta?.restartRequested, true);
});

test('fetchPollState throws an endpoint-specific error on non-2xx responses', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  await assert.rejects(() => client.fetchPollState(), /Failed to fetch poll state \(503\)/);
});

test('claimTrigger returns conflict=false/ok=true on success and conflict=true on 409', async () => {
  const calls: Array<RequestInit | undefined> = [];
  const responses = [new Response(null, { status: 200 }), new Response(null, { status: 409 })];

  globalThis.fetch = (async (_url, options) => {
    calls.push(options);
    return responses.shift() as Response;
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  assert.deepEqual(await client.claimTrigger('t1'), { ok: true, conflict: false });
  assert.deepEqual(await client.claimTrigger('t2'), { ok: false, conflict: true });
  assert.equal((calls[0]?.headers as Record<string, string>)['X-AgentTeams-Client'], 'daemon');
  assert.equal((calls[0]?.headers as Record<string, string>)['x-runner-version'], runnerVersion);
});

test('updateTriggerStatus sends JSON payload including optional error message', async () => {
  const calls: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url, options) => {
    calls.push(options);
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  await client.updateTriggerStatus('t1', 'FAILED', 'boom');

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
    status: 'FAILED',
    errorMessage: 'boom',
  });
  assert.equal((calls[0]?.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('reportWorktreeStatus sends JSON payload including optional worktree error', async () => {
  const calls: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url, options) => {
    calls.push(options);
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  await client.reportWorktreeStatus('t1', 'FAILED', 'worktree missing');

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
    worktreeStatus: 'FAILED',
    worktreeError: 'worktree missing',
  });
});

test('appendTriggerLogs throws when the API responds with an error', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  await assert.rejects(
    () => client.appendTriggerLogs('t1', { heartbeat: true }),
    /Failed to append trigger logs \(500\)/,
  );
});

test('requestWithRetry retries network failures with exponential backoff and warning logs', async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, 'warn', (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta });
  });

  const delays: number[] = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    if (delay === DAEMON_API_TRANSPORT_TIMEOUT_MS) {
      return 0 as unknown as NodeJS.Timeout;
    }
    delays.push(delay ?? 0);
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    if (attempt < 3) {
      throw new Error(`network-${attempt}`);
    }

    return new Response(
      JSON.stringify({
        data: {
          orphanedCancelRequestedTriggerIds: [],
          pendingWorktreeRemovals: [],
          pendingTrigger: null,
        },
        meta: { cliLatestVersion: null, runnerLatestVersion: null },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  const result = await client.fetchPollState();

  assert.deepEqual(result.data.orphanedCancelRequestedTriggerIds, []);
  assert.deepEqual(result.data.pendingWorktreeRemovals, []);
  assert.equal(result.data.pendingTrigger, null);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]?.message ?? '', /Retry 1\/3/);
  assert.equal(warnings[1]?.meta?.delayMs, 2000);
});

test('requestWithRetry aborts stalled requests at the transport timeout and retries safely', async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, 'warn', (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta });
  });

  const delays: number[] = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    delays.push(delay ?? 0);
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  const signals: AbortSignal[] = [];
  globalThis.fetch = (async (_url, options) => {
    const signal = options?.signal;
    assert.ok(signal);
    signals.push(signal);
    await new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    throw new Error('unreachable');
  }) as typeof fetch;

  const client = new DaemonApiClient('https://api.example', 'daemon-token');
  await assert.rejects(() => client.fetchPollState(), /timed out/);

  assert.equal(signals.length, 4, 'initial request plus three retries');
  assert.ok(signals.every((signal) => signal.aborted));
  assert.deepEqual(delays, [30_000, 1000, 30_000, 2000, 30_000, 4000, 30_000]);
  assert.equal(warnings.length, 3);
  assert.deepEqual(
    warnings.map((warning) => ({
      path: warning.meta?.path,
      retryNumber: warning.meta?.retryNumber,
      delayMs: warning.meta?.delayMs,
      timeoutMs: warning.meta?.timeoutMs,
    })),
    [
      { path: '/api/daemon-triggers/poll-state', retryNumber: 1, delayMs: 1000, timeoutMs: 30_000 },
      { path: '/api/daemon-triggers/poll-state', retryNumber: 2, delayMs: 2000, timeoutMs: 30_000 },
      { path: '/api/daemon-triggers/poll-state', retryNumber: 3, delayMs: 4000, timeoutMs: 30_000 },
    ],
  );
  assert.ok(warnings.every((warning) => !JSON.stringify(warning).includes('daemon-token')));
  assert.ok(warnings.every((warning) => !JSON.stringify(warning).includes('https://api.example')));
});
