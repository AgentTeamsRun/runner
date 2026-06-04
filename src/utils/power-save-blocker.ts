import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { logger } from "../logger.js";

// launchd 환경에서는 PATH가 비어 있을 수 있으므로 macOS 시스템 바이너리는 절대 경로로 호출한다.
const CAFFEINATE_PATH = "/usr/bin/caffeinate";
const PMSET_PATH = "/usr/bin/pmset";

// -i: 시스템 idle 절전 방지, -m: 디스크 idle 절전 방지, -s: 시스템 절전 방지(AC 전원에서만 유효)
const DEFAULT_CAFFEINATE_ARGS = ["-i", "-m", "-s"];

// 실행 도중 배터리로 전환되는 경우를 감지하기 위한 전원 상태 재확인 주기
const DEFAULT_POWER_RECHECK_INTERVAL_MS = 30_000;

export type PowerSource = "AC" | "BATTERY" | "UNKNOWN";

export type PowerSaveBlocker = {
  // 절전 방지 세션을 획득한다. 반환된 release는 여러 번 호출해도 안전(idempotent)하다.
  acquire: (label?: string) => () => void;
};

type PowerSaveBlockerDeps = {
  platform?: () => NodeJS.Platform;
  spawn?: typeof spawn;
  execFileSync?: typeof execFileSync;
  logger?: Pick<typeof logger, "info" | "warn">;
  setInterval?: typeof global.setInterval;
  clearInterval?: typeof global.clearInterval;
  recheckIntervalMs?: number;
  caffeinateArgs?: string[];
  enabled?: boolean;
};

// `pmset -g batt`의 첫 줄은 "Now drawing from 'AC Power'" 또는 "Now drawing from 'Battery Power'" 형태다.
export const parsePowerSource = (output: string): PowerSource => {
  const match = output.match(/Now drawing from '([^']+)'/i);
  if (!match) {
    return "UNKNOWN";
  }

  const source = match[1].toLowerCase();
  if (source.includes("ac")) {
    return "AC";
  }
  if (source.includes("battery")) {
    return "BATTERY";
  }
  return "UNKNOWN";
};

const noopRelease = (): void => {};

export const createPowerSaveBlocker = (deps: PowerSaveBlockerDeps = {}): PowerSaveBlocker => {
  const platform = deps.platform ?? osPlatform;
  const spawnFn = deps.spawn ?? spawn;
  const execFileSyncFn = deps.execFileSync ?? execFileSync;
  const log = deps.logger ?? logger;
  const setIntervalFn = deps.setInterval ?? global.setInterval;
  const clearIntervalFn = deps.clearInterval ?? global.clearInterval;
  const recheckIntervalMs = deps.recheckIntervalMs ?? DEFAULT_POWER_RECHECK_INTERVAL_MS;
  const caffeinateArgs = deps.caffeinateArgs ?? DEFAULT_CAFFEINATE_ARGS;

  // 기능 토글이 꺼져 있거나 macOS가 아니면 전부 no-op으로 동작한다.
  const supported = (deps.enabled ?? true) && platform() === "darwin";

  let activeSessions = 0;
  let caffeinate: ChildProcess | null = null;
  let monitorInterval: NodeJS.Timeout | null = null;

  const readPowerSource = (): PowerSource => {
    try {
      const output = String(execFileSyncFn(PMSET_PATH, ["-g", "batt"], { encoding: "utf8" }));
      return parsePowerSource(output);
    } catch (error) {
      log.warn("Failed to read power source via pmset", {
        error: error instanceof Error ? error.message : String(error)
      });
      return "UNKNOWN";
    }
  };

  const startCaffeinate = (): void => {
    if (caffeinate) {
      return;
    }

    try {
      const child = spawnFn(CAFFEINATE_PATH, caffeinateArgs, { stdio: "ignore" });
      child.on("error", (error) => {
        log.warn("caffeinate process failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        if (caffeinate === child) {
          caffeinate = null;
        }
      });
      child.on("exit", () => {
        if (caffeinate === child) {
          caffeinate = null;
        }
      });
      caffeinate = child;
      log.info("Sleep prevention started", { pid: child.pid ?? null, args: caffeinateArgs });
    } catch (error) {
      log.warn("Failed to start caffeinate", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const stopCaffeinate = (reason: string): void => {
    if (!caffeinate) {
      return;
    }

    const child = caffeinate;
    caffeinate = null;
    try {
      child.kill("SIGTERM");
    } catch {
      // 이미 종료되었거나 종료할 수 없는 경우 무시한다.
    }
    log.info("Sleep prevention stopped", { reason });
  };

  // 의도한 상태(세션 존재 && AC 전원)와 실제 caffeinate 실행 여부를 일치시킨다.
  const reconcile = (): void => {
    if (!supported) {
      return;
    }

    if (activeSessions <= 0) {
      stopCaffeinate("no-active-sessions");
      return;
    }

    const source = readPowerSource();
    if (source === "AC") {
      startCaffeinate();
    } else {
      stopCaffeinate(source === "BATTERY" ? "on-battery" : "power-source-unknown");
    }
  };

  const startMonitor = (): void => {
    if (monitorInterval) {
      return;
    }
    monitorInterval = setIntervalFn(() => reconcile(), recheckIntervalMs);
    // 절전 방지 모니터가 데몬 종료를 막지 않도록 unref 처리한다.
    if (typeof monitorInterval.unref === "function") {
      monitorInterval.unref();
    }
  };

  const stopMonitor = (): void => {
    if (!monitorInterval) {
      return;
    }
    clearIntervalFn(monitorInterval);
    monitorInterval = null;
  };

  const acquire = (label?: string): (() => void) => {
    if (!supported) {
      return noopRelease;
    }

    activeSessions += 1;
    const source = readPowerSource();
    if (source !== "AC") {
      log.info("Sleep prevention skipped while on battery or unknown power", { source, label: label ?? null });
    }
    reconcile();
    startMonitor();

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
      reconcile();
      if (activeSessions === 0) {
        stopMonitor();
      }
    };
  };

  return { acquire };
};
