import { logger } from '../logger.js';
import { getDaemonStatus, removePidFile, verifyRecordedDaemonInstance } from '../pid.js';

type StopCommandDeps = {
  getDaemonStatus?: typeof getDaemonStatus;
  removePidFile?: typeof removePidFile;
  verifyRecordedDaemonInstance?: (pid: number) => ReturnType<typeof verifyRecordedDaemonInstance>;
  kill?: typeof process.kill;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
};

export const runStopCommand = async (deps: StopCommandDeps = {}): Promise<void> => {
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedRemovePidFile = deps.removePidFile ?? removePidFile;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedLogger = deps.logger ?? logger;

  const { running, pid } = await resolvedGetDaemonStatus();

  if (!running || pid === null) {
    resolvedLogger.info('Daemon is not running');
    return;
  }

  // 비정상 종료한 러너의 PID 기록이 남아 있고 Windows가 그 PID를 재사용했다면 지금 그 PID는 무관한 프로세스다.
  // 재시작 경로(`terminateDaemonInstance`)와 같은 기준으로, `mismatch`일 때는 신호 없이 기록만 버린다.
  if ((await (deps.verifyRecordedDaemonInstance ?? verifyRecordedDaemonInstance)(pid)) === 'mismatch') {
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
