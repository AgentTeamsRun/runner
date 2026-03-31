import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { DaemonApiClient } from "./api-client.js";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const runnerVersion = packageJson.version ?? "0.0.0";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  mock.restoreAll();
});

test("validateDaemonToken sends daemon header and returns payload data", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const expectedOsType = process.platform === "darwin"
    ? "MACOS"
    : process.platform === "win32"
      ? "WINDOWS"
      : process.platform === "linux"
        ? "LINUX"
        : undefined;

  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { id: "d1", memberId: "m1", label: null, osType: "MACOS", runnerVersion, supportedEngines: ["CODEX"], lastSeenAt: null, createdAt: "c", updatedAt: "u" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const client = new DaemonApiClient("https://api.example", "daemon-token");
  const result = await client.validateDaemonToken();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.example/api/daemons/me");
  assert.deepEqual(calls[0]?.options?.headers, expectedOsType
    ? {
      "x-daemon-token": "daemon-token",
      "x-runner-version": runnerVersion,
      "x-os-type": expectedOsType
    }
    : {
      "x-daemon-token": "daemon-token",
      "x-runner-version": runnerVersion
    });
  assert.equal(result.id, "d1");
  assert.equal(result.osType, "MACOS");
  assert.deepEqual(result.supportedEngines, ["CODEX"]);
});

test("claimTrigger returns conflict=false/ok=true on success and conflict=true on 409", async () => {
  const calls: Array<RequestInit | undefined> = [];
  const responses = [
    new Response(null, { status: 200 }),
    new Response(null, { status: 409 })
  ];

  globalThis.fetch = (async (_url, options) => {
    calls.push(options);
    return responses.shift() as Response;
  }) as typeof fetch;

  const client = new DaemonApiClient("https://api.example", "daemon-token");
  assert.deepEqual(await client.claimTrigger("t1"), { ok: true, conflict: false });
  assert.deepEqual(await client.claimTrigger("t2"), { ok: false, conflict: true });
  assert.equal((calls[0]?.headers as Record<string, string>)["x-runner-version"], runnerVersion);
});

test("updateTriggerStatus sends JSON payload including optional error message", async () => {
  const calls: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url, options) => {
    calls.push(options);
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const client = new DaemonApiClient("https://api.example", "daemon-token");
  await client.updateTriggerStatus("t1", "FAILED", "boom");

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
    status: "FAILED",
    errorMessage: "boom"
  });
  assert.equal((calls[0]?.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("reportWorktreeStatus sends JSON payload including optional worktree error", async () => {
  const calls: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url, options) => {
    calls.push(options);
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const client = new DaemonApiClient("https://api.example", "daemon-token");
  await client.reportWorktreeStatus("t1", "FAILED", "worktree missing");

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
    worktreeStatus: "FAILED",
    worktreeError: "worktree missing"
  });
});

test("appendTriggerLogs throws when the API responds with an error", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

  const client = new DaemonApiClient("https://api.example", "daemon-token");
  await assert.rejects(
    () => client.appendTriggerLogs("t1", { heartbeat: true }),
    /Failed to append trigger logs \(500\)/
  );
});

test("requestWithRetry retries network failures with exponential backoff and warning logs", async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, "warn", (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta });
  });

  const delays: number[] = [];
  globalThis.setTimeout = (((callback: (...args: unknown[]) => void, delay?: number) => {
    delays.push(delay ?? 0);
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);

  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    if (attempt < 3) {
      throw new Error(`network-${attempt}`);
    }

    return new Response(JSON.stringify({ data: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const client = new DaemonApiClient("https://api.example", "daemon-token");
  const result = await client.fetchPendingTrigger();

  assert.deepEqual(result, { data: null });
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]?.message ?? "", /Retry 1\/3/);
  assert.equal(warnings[1]?.meta?.delayMs, 2000);
});
