import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { logger } from "../logger.js";
import { TriggerLogReporter, mergeLogs } from "./log-reporter.js";

type Payload = {
  logs?: Array<{ level: string; message: string }>;
  heartbeat?: boolean;
};

test.afterEach(() => {
  mock.restoreAll();
});

test("TriggerLogReporter normalizes log messages and drains them on stop", async () => {
  const payloads: Payload[] = [];
  const client = {
    appendTriggerLogs: async (_triggerId: string, payload: Payload) => {
      payloads.push(payload);
    }
  };

  const reporter = new TriggerLogReporter(client as never, "trigger-1");
  reporter.append("INFO", "\u001B[31m hello \r\n\r\n\r\nworld \u0007");
  reporter.append("WARN", "   ");
  await reporter.stop();

  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    logs: [{ level: "INFO", message: "hello \n\nworld" }],
    heartbeat: true
  });
});

test("TriggerLogReporter prepends a dropped-log warning when the buffer overflows", async () => {
  const payloads: Payload[] = [];
  const client = {
    appendTriggerLogs: async (_triggerId: string, payload: Payload) => {
      payloads.push(payload);
    }
  };

  const reporter = new TriggerLogReporter(client as never, "trigger-1");
  for (let index = 0; index < 501; index += 1) {
    reporter.append("INFO", `line-${index}`);
  }

  await reporter.stop();

  const flattened = payloads.flatMap((payload) => payload.logs ?? []);
  assert.match(flattened[0]?.message ?? "", /Dropped 1 log line/);
  // After merging, 501 individual logs are compressed into fewer records.
  // The dropped warning (WARN) splits from the INFO logs, so we get at least 2 records.
  assert.ok(flattened.length < 501, `Expected merged log count to be less than 501, got ${flattened.length}`);
  assert.ok(flattened.length >= 2, `Expected at least 2 merged records (WARN + INFO), got ${flattened.length}`);
  // Last merged record should contain line-500
  assert.match(flattened.at(-1)?.message ?? "", /line-500/);
});

test("TriggerLogReporter sends heartbeat flushes on interval and start is idempotent", async () => {
  const payloads: Payload[] = [];
  const intervals: Array<() => void> = [];
  const intervalHandles: object[] = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = (((callback: () => void) => {
    intervals.push(callback);
    const handle = {};
    intervalHandles.push(handle);
    return handle as NodeJS.Timeout;
  }) as typeof setInterval);

  globalThis.clearInterval = (((handle: NodeJS.Timeout) => {
    assert.equal(intervalHandles.includes(handle as unknown as object), true);
  }) as typeof clearInterval);

  try {
    const client = {
      appendTriggerLogs: async (_triggerId: string, payload: Payload) => {
        payloads.push(payload);
      }
    };

    const reporter = new TriggerLogReporter(client as never, "trigger-1", 10);
    reporter.start();
    reporter.start();

    assert.equal(intervals.length, 1);

    await intervals[0]?.();
    await reporter.stop();

    assert.equal(payloads[0]?.heartbeat, true);
    assert.equal(payloads[0]?.logs, undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("TriggerLogReporter logs warnings when log delivery fails", async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mock.method(logger, "warn", (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta });
  });

  const client = {
    appendTriggerLogs: async () => {
      throw new Error("network down");
    }
  };

  const reporter = new TriggerLogReporter(client as never, "trigger-1");
  reporter.append("ERROR", "failure");
  await reporter.stop();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /Failed to report trigger logs/);
  assert.equal(warnings[0]?.meta?.payloadSize, 1);
});

test("mergeLogs merges consecutive same-level logs with newline separator", () => {
  const result = mergeLogs([
    { level: "INFO", message: "line 1" },
    { level: "INFO", message: "line 2" },
    { level: "INFO", message: "line 3" }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].level, "INFO");
  assert.equal(result[0].message, "line 1\nline 2\nline 3");
});

test("mergeLogs splits at level boundaries", () => {
  const result = mergeLogs([
    { level: "INFO", message: "info 1" },
    { level: "INFO", message: "info 2" },
    { level: "WARN", message: "warn 1" },
    { level: "INFO", message: "info 3" }
  ]);

  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { level: "INFO", message: "info 1\ninfo 2" });
  assert.deepEqual(result[1], { level: "WARN", message: "warn 1" });
  assert.deepEqual(result[2], { level: "INFO", message: "info 3" });
});

test("mergeLogs splits when combined message exceeds 2000 chars", () => {
  const longMessage = "x".repeat(1500);
  const result = mergeLogs([
    { level: "INFO", message: longMessage },
    { level: "INFO", message: longMessage }
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].message, longMessage);
  assert.equal(result[1].message, longMessage);
});

test("mergeLogs returns empty array for empty input", () => {
  assert.deepEqual(mergeLogs([]), []);
});

test("TriggerLogReporter merges same-level logs during flush", async () => {
  const payloads: Payload[] = [];
  const client = {
    appendTriggerLogs: async (_triggerId: string, payload: Payload) => {
      payloads.push(payload);
    }
  };

  const reporter = new TriggerLogReporter(client as never, "trigger-1");
  reporter.append("INFO", "line 1");
  reporter.append("INFO", "line 2");
  reporter.append("WARN", "warning");
  reporter.append("INFO", "line 3");
  await reporter.stop();

  const logs = payloads.flatMap((p) => p.logs ?? []);
  assert.equal(logs.length, 3);
  assert.deepEqual(logs[0], { level: "INFO", message: "line 1\nline 2" });
  assert.deepEqual(logs[1], { level: "WARN", message: "warning" });
  assert.deepEqual(logs[2], { level: "INFO", message: "line 3" });
});
