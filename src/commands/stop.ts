import { platform as getPlatform } from 'node:os';
import { stopWindowsDaemonInstance } from '../daemon-stop.js';
import { logger } from '../logger.js';
import { getDaemonStatus, removePidFile, verifyRecordedDaemonInstance } from '../pid.js';

type StopCommandDeps = {
  getDaemonStatus?: typeof getDaemonStatus;
  removePidFile?: typeof removePidFile;
  verifyRecordedDaemonInstance?: (pid: number) => ReturnType<typeof verifyRecordedDaemonInstance>;
  kill?: typeof process.kill;
  platform?: () => NodeJS.Platform;
  stopWindowsDaemonInstance?: typeof stopWindowsDaemonInstance;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
};

export const runStopCommand = async (deps: StopCommandDeps = {}): Promise<void> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedRemovePidFile = deps.removePidFile ?? removePidFile;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedLogger = deps.logger ?? logger;
  const resolvedVerify = deps.verifyRecordedDaemonInstance ?? verifyRecordedDaemonInstance;

  const { running, pid } = await resolvedGetDaemonStatus();

  if (!running || pid === null) {
    resolvedLogger.info('Daemon is not running');
    return;
  }

  // Windows의 SIGTERM은 TerminateProcess라 러너가 실행을 취소·보고할 기회 없이 죽고 엔진이 고아로 남는다.
  // 종료 채널로 정상 종료를 요청하고 실제로 끝날 때까지 기다린다. 멈추지 못하면 예외가 올라가
  // 명령이 0이 아닌 코드로 끝나고, PID 기록은 남는다 — 살아 있는 러너를 "멈췄다"고 보고하지 않는다.
  if ((deps.platform ?? getPlatform)() === 'win32') {
    const outcome = await (deps.stopWindowsDaemonInstance ?? stopWindowsDaemonInstance)(pid, {
      verifyRecordedDaemonInstance: resolvedVerify,
      removePidFile: () => resolvedRemovePidFile(),
      logger: resolvedLogger,
    });
    if (outcome.status === 'stale-record') {
      return;
    }
    if (outcome.status === 'forced') {
      resolvedLogger.warn('Stopped daemon by terminating its process tree', { pid, reason: outcome.reason });
    } else {
      resolvedLogger.info('Stopped daemon', { pid });
    }
    await resolvedRemovePidFile();
    return;
  }

  // 비정상 종료한 러너의 PID 기록이 남아 있고 OS가 그 PID를 재사용했다면 지금 그 PID는 무관한 프로세스다.
  // 재시작 경로(`terminateDaemonInstance`)와 같은 기준으로, `mismatch`일 때는 신호 없이 기록만 버린다.
  if ((await resolvedVerify(pid)) === 'mismatch') {
    resolvedLogger.warn(
      'The recorded AgentRunner PID now belongs to an unrelated process — discarding the stale record',
      { pid },
    );
    await resolvedRemovePidFile();
    return;
  }

  try {
    resolvedKill(pid, 'SIGTERM');
    resolvedLogger.info('Sent SIGTERM to daemon', { pid });
  } catch (error) {
    resolvedLogger.error('Failed to stop daemon', {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await resolvedRemovePidFile();
};
