import { execFileSync, type spawn } from 'node:child_process';
import { logger } from '../logger.js';

const FORCE_KILL_AFTER_MS = 10_000;
const FORCE_CLOSE_AFTER_EXIT_MS = 5_000;

type ChildProcess = ReturnType<typeof spawn>;

// taskkill /T는 PowerShell 래퍼와 그 아래 엔진 트리를 함께 끝낸다. 실패하면(권한, taskkill 부재, 이미 종료된
// 래퍼) 최소한 래퍼만이라도 끝내 stdio가 닫히게 한다.
const killWindowsProcessTree = (child: ChildProcess, triggerId: string): void => {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    logger.warn('taskkill could not terminate the runner process tree; killing the wrapper process only', {
      triggerId,
      pid: child.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
};

export const terminateRunnerChild = (
  child: ChildProcess,
  isWindows: boolean,
  triggerId: string,
  reason: 'timeout' | 'cancel',
): void => {
  if (!child.pid) {
    return;
  }

  logger.warn(
    reason === 'cancel'
      ? 'Runner cancellation requested; sending SIGTERM'
      : 'Runner fail-safe timeout reached; sending SIGTERM',
    {
      triggerId,
      pid: child.pid,
    },
  );

  if (isWindows) {
    killWindowsProcessTree(child, triggerId);
    // taskkill은 한 번 실패하면 끝이었다. 트리가 남으면 stdout 파이프가 닫히지 않아 실행이 끝나지 않으므로,
    // POSIX의 SIGKILL 유예와 같은 시점에 아직 살아 있는지 보고 한 번 더 정리한다.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn('Runner process survived the first termination attempt; retrying', {
          triggerId,
          pid: child.pid,
        });
        killWindowsProcessTree(child, triggerId);
      }
    }, FORCE_KILL_AFTER_MS).unref();
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // ignore
  }

  if (!isWindows) {
    setTimeout(() => {
      try {
        if (child.pid) {
          process.kill(-child.pid, 'SIGKILL');
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
export const setupCloseWatchdog = (child: ChildProcess, triggerId: string): { cancel: () => void } => {
  let watchdog: NodeJS.Timeout | null = null;

  child.on('exit', (code) => {
    if (watchdog) {
      return;
    }
    watchdog = setTimeout(() => {
      logger.warn('Runner exited but stdio pipes still open; forcing close', {
        triggerId,
        pid: child.pid,
        exitCode: code,
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
    },
  };
};
