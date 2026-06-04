import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPowerSaveBlocker, parsePowerSource } from "./power-save-blocker.js";

const AC_OUTPUT = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t100%; charged; 0:00 remaining present: true";
const BATTERY_OUTPUT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t80%; discharging; 3:20 remaining present: true";

type FakeChild = EventEmitter & { pid: number; killed: boolean; kill: (signal?: string) => boolean };

const createFakeChild = (pid: number): FakeChild => {
  const emitter = new EventEmitter() as FakeChild;
  emitter.pid = pid;
  emitter.killed = false;
  emitter.kill = () => {
    emitter.killed = true;
    return true;
  };
  return emitter;
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined
};

// setInterval/clearInterval를 주입해 모니터 루프가 실제 타이머를 만들지 않게 한다.
const noopTimers = {
  setInterval: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as typeof global.setInterval,
  clearInterval: (() => undefined) as typeof global.clearInterval
};

test("parsePowerSource detects AC, battery, and unknown sources", () => {
  assert.equal(parsePowerSource(AC_OUTPUT), "AC");
  assert.equal(parsePowerSource(BATTERY_OUTPUT), "BATTERY");
  assert.equal(parsePowerSource("garbage output"), "UNKNOWN");
});

test("acquire spawns caffeinate on macOS while on AC power", () => {
  const spawned: Array<{ command: string; args: string[] }> = [];
  const child = createFakeChild(4242);

  const blocker = createPowerSaveBlocker({
    platform: () => "darwin",
    execFileSync: (() => AC_OUTPUT) as never,
    spawn: ((command: string, args: string[]) => {
      spawned.push({ command, args });
      return child as never;
    }) as never,
    logger: silentLogger,
    ...noopTimers
  });

  const release = blocker.acquire("trigger-1");

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.command, "/usr/bin/caffeinate");
  assert.deepEqual(spawned[0]?.args, ["-i", "-m", "-s"]);

  release();
  assert.equal(child.killed, true);
});

test("acquire is a no-op while on battery power", () => {
  let spawnCalls = 0;
  const blocker = createPowerSaveBlocker({
    platform: () => "darwin",
    execFileSync: (() => BATTERY_OUTPUT) as never,
    spawn: (() => {
      spawnCalls += 1;
      return createFakeChild(1) as never;
    }) as never,
    logger: silentLogger,
    ...noopTimers
  });

  const release = blocker.acquire();
  assert.equal(spawnCalls, 0);
  release();
});

test("acquire is a no-op on non-macOS platforms", () => {
  let spawnCalls = 0;
  let pmsetCalls = 0;
  const blocker = createPowerSaveBlocker({
    platform: () => "linux",
    execFileSync: (() => {
      pmsetCalls += 1;
      return AC_OUTPUT;
    }) as never,
    spawn: (() => {
      spawnCalls += 1;
      return createFakeChild(1) as never;
    }) as never,
    logger: silentLogger,
    ...noopTimers
  });

  const release = blocker.acquire();
  assert.equal(spawnCalls, 0);
  assert.equal(pmsetCalls, 0);
  release();
});

test("acquire is a no-op when the feature is disabled", () => {
  let spawnCalls = 0;
  const blocker = createPowerSaveBlocker({
    platform: () => "darwin",
    enabled: false,
    execFileSync: (() => AC_OUTPUT) as never,
    spawn: (() => {
      spawnCalls += 1;
      return createFakeChild(1) as never;
    }) as never,
    logger: silentLogger,
    ...noopTimers
  });

  blocker.acquire()();
  assert.equal(spawnCalls, 0);
});

test("release can be called multiple times without killing twice", () => {
  let killCount = 0;
  const child = createFakeChild(7);
  child.kill = () => {
    killCount += 1;
    child.killed = true;
    return true;
  };

  const blocker = createPowerSaveBlocker({
    platform: () => "darwin",
    execFileSync: (() => AC_OUTPUT) as never,
    spawn: (() => child as never) as never,
    logger: silentLogger,
    ...noopTimers
  });

  const release = blocker.acquire();
  release();
  release();
  release();

  assert.equal(killCount, 1);
});

test("concurrent sessions keep caffeinate alive until the last release", () => {
  let spawnCalls = 0;
  const child = createFakeChild(9);

  const blocker = createPowerSaveBlocker({
    platform: () => "darwin",
    execFileSync: (() => AC_OUTPUT) as never,
    spawn: (() => {
      spawnCalls += 1;
      return child as never;
    }) as never,
    logger: silentLogger,
    ...noopTimers
  });

  const releaseA = blocker.acquire("a");
  const releaseB = blocker.acquire("b");

  // 두 세션이 동일한 caffeinate 프로세스를 공유한다.
  assert.equal(spawnCalls, 1);

  releaseA();
  assert.equal(child.killed, false);

  releaseB();
  assert.equal(child.killed, true);
});

test("monitor releases caffeinate when power switches to battery mid-run", () => {
  let powerOutput = AC_OUTPUT;
  const monitorTicks: Array<() => void> = [];
  const child = createFakeChild(11);

  const blocker = createPowerSaveBlocker({
    platform: () => "darwin",
    execFileSync: (() => powerOutput) as never,
    spawn: (() => child as never) as never,
    logger: silentLogger,
    setInterval: ((handler: () => void) => {
      monitorTicks.push(handler);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }) as typeof global.setInterval,
    clearInterval: (() => undefined) as typeof global.clearInterval
  });

  blocker.acquire();
  assert.equal(child.killed, false);

  // 배터리로 전환된 뒤 모니터가 동작하면 caffeinate가 종료되어야 한다.
  powerOutput = BATTERY_OUTPUT;
  assert.equal(monitorTicks.length, 1, "monitor interval should be registered");
  monitorTicks[0]?.();

  assert.equal(child.killed, true);
});
