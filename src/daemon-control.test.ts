import assert from "node:assert/strict";
import test from "node:test";
import { restartDaemon } from "./daemon-control.js";

test("restartDaemon stops running daemon and restarts via autostart when registered", async () => {
  const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
  let statusChecks = 0;
  let restarted = false;

  await restartDaemon({
    getDaemonStatus: async () => {
      statusChecks += 1;
      if (statusChecks === 1) {
        return { running: true, pid: 4321 };
      }

      return { running: false, pid: null };
    },
    getAutostartStatus: () => ({ registered: true, platform: "systemd" }),
    restartAutostartService: async () => {
      restarted = true;
    },
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
    sleep: async () => undefined,
    logger: { info: () => undefined }
  });

  assert.deepEqual(signals, [{ pid: 4321, signal: "SIGTERM" }]);
  assert.equal(restarted, true);
});

test("restartDaemon starts detached daemon when autostart is not registered", async () => {
  let started = false;

  await restartDaemon({
    getDaemonStatus: async () => ({ running: false, pid: null }),
    getAutostartStatus: () => ({ registered: false, platform: "manual" }),
    restartAutostartService: async () => {
      throw new Error("should not restart autostart");
    },
    spawnDetachedDaemon: () => {
      started = true;
      return {
        unref: () => undefined
      };
    },
    logger: { info: () => undefined }
  });

  assert.equal(started, true);
});
