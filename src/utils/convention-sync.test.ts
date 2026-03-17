import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { runConventionSync } from "./convention-sync.js";

const createFakeSpawn = (exitCode: number | null, error?: Error) => {
  return (_cmd: string, _args: string[], _opts: object): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    process.nextTick(() => {
      if (error) {
        child.emit("error", error);
      } else {
        child.emit("close", exitCode);
      }
    });
    return child;
  };
};

test.afterEach(() => {
  mock.restoreAll();
});

test("runConventionSync logs info on exit code 0", async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => { logs.push({ level: "info", message, meta }); },
    warn: (message: string, meta?: object) => { logs.push({ level: "warn", message, meta }); },
  };

  await runConventionSync("/fake/path", {
    spawn: createFakeSpawn(0) as any,
    logger: fakeLogger,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "info");
  assert.match(logs[0]!.message, /completed/i);
});

test("runConventionSync logs warn on non-zero exit code", async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => { logs.push({ level: "info", message, meta }); },
    warn: (message: string, meta?: object) => { logs.push({ level: "warn", message, meta }); },
  };

  await runConventionSync("/fake/path", {
    spawn: createFakeSpawn(1) as any,
    logger: fakeLogger,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "warn");
  assert.match(logs[0]!.message, /non-zero/i);
});

test("runConventionSync logs warn on spawn error", async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => { logs.push({ level: "info", message, meta }); },
    warn: (message: string, meta?: object) => { logs.push({ level: "warn", message, meta }); },
  };

  await runConventionSync("/fake/path", {
    spawn: createFakeSpawn(null, new Error("ENOENT")) as any,
    logger: fakeLogger,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "warn");
  assert.match(logs[0]!.message, /spawn error/i);
});

test("runConventionSync never throws", async () => {
  const fakeLogger = {
    info: () => {},
    warn: () => {},
  };

  const throwingSpawn = () => { throw new Error("unexpected"); };

  await assert.doesNotReject(
    runConventionSync("/fake/path", {
      spawn: throwingSpawn as any,
      logger: fakeLogger,
    })
  );
});
