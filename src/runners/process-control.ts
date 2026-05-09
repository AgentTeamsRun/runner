import { execFileSync, type spawn } from "node:child_process";
import { logger } from "../logger.js";

const FORCE_KILL_AFTER_MS = 10_000;
const FORCE_CLOSE_AFTER_EXIT_MS = 5_000;

type ChildProcess = ReturnType<typeof spawn>;

export const terminateRunnerChild = (
  child: ChildProcess,
  isWindows: boolean,
  triggerId: string,
  reason: "timeout" | "cancel"
): void => {
  if (!child.pid) {
    return;
  }

  logger.warn(reason === "cancel" ? "Runner cancellation requested; sending SIGTERM" : "Runner fail-safe timeout reached; sending SIGTERM", {
    triggerId,
    pid: child.pid
  });

  try {
    if (isWindows) {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // ignore
  }

  if (!isWindows) {
    setTimeout(() => {
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // ignore
      }
    }, FORCE_KILL_AFTER_MS);
  }
};

// 'exit'은 프로세스 종료 시점, 'close'는 stdio가 모두 닫힌 시점.
// orphan 손자 프로세스가 부모의 stdio pipe를 inherit한 채 살아있으면
// 'exit'은 떠도 'close'는 영영 안 와서 runner.run()이 hang한다.
// exit 후 일정 시간 안에 close가 안 오면 stdio를 강제로 destroy해서 close를 유발한다.
export const setupCloseWatchdog = (
  child: ChildProcess,
  triggerId: string
): { cancel: () => void } => {
  let watchdog: NodeJS.Timeout | null = null;

  child.on("exit", (code) => {
    if (watchdog) {
      return;
    }
    watchdog = setTimeout(() => {
      logger.warn("Runner exited but stdio pipes still open; forcing close", {
        triggerId,
        pid: child.pid,
        exitCode: code
      });
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, FORCE_CLOSE_AFTER_EXIT_MS);
  });

  return {
    cancel: () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    }
  };
};
