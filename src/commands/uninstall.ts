import { platform as getPlatform } from 'node:os';
import { stopWindowsDaemonInstance } from '../daemon-stop.js';
import { logger } from '../logger.js';
import { getDaemonStatus, removePidFile, verifyRecordedDaemonInstance } from '../pid.js';
import { getAutostartStatus, unregisterAutostart } from '../autostart.js';

type UninstallCommandDeps = {
  getAutostartStatus?: typeof getAutostartStatus;
  unregisterAutostart?: typeof unregisterAutostart;
  getDaemonStatus?: typeof getDaemonStatus;
  removePidFile?: typeof removePidFile;
  verifyRecordedDaemonInstance?: (pid: number) => ReturnType<typeof verifyRecordedDaemonInstance>;
  kill?: typeof process.kill;
  platform?: () => NodeJS.Platform;
  stopWindowsDaemonInstance?: typeof stopWindowsDaemonInstance;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
};

export const runUninstallCommand = async (deps: UninstallCommandDeps = {}): Promise<void> => {
  const resolvedGetAutostartStatus = deps.getAutostartStatus ?? getAutostartStatus;
  const resolvedUnregisterAutostart = deps.unregisterAutostart ?? unregisterAutostart;
  const resolvedGetDaemonStatus = deps.getDaemonStatus ?? getDaemonStatus;
  const resolvedRemovePidFile = deps.removePidFile ?? removePidFile;
  const resolvedKill = deps.kill ?? process.kill.bind(process);
  const resolvedLogger = deps.logger ?? logger;

  const autostartStatus = resolvedGetAutostartStatus();
  const isWindowsTask = autostartStatus.platform === 'task-scheduler';
  if (isWindowsTask) {
    await resolvedUnregisterAutostart();
  }

  const { running, pid } = await resolvedGetDaemonStatus();

  if (running && pid !== null && (deps.platform ?? getPlatform)() === 'win32') {
    // `agentrunner stop`과 같은 경로: 정상 종료를 요청해 실행을 취소·보고하게 하고 엔진 트리를 남기지 않는다.
    // 멈추지 못해도 제거 자체는 계속한다 — 자동시작은 이미 해제됐고, 남은 프로세스는 경고로 알린다.
    try {
      const outcome = await (deps.stopWindowsDaemonInstance ?? stopWindowsDaemonInstance)(pid, {
        verifyRecordedDaemonInstance: deps.verifyRecordedDaemonInstance,
        removePidFile: () => resolvedRemovePidFile(),
        logger: resolvedLogger,
      });
      // stale-record는 공용 경로가 기록을 이미 버렸다.
      if (outcome.status !== 'stale-record') {
        resolvedLogger.info('Stopped running daemon', { pid });
        await resolvedRemovePidFile();
      }
    } catch (error) {
      resolvedLogger.warn('Could not stop the running daemon; stop it manually', {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (running && pid !== null) {
    // `agentrunner stop`과 같은 이유로, PID를 재사용한 무관한 프로세스에는 신호를 보내지 않는다.
    const verification = await (deps.verifyRecordedDaemonInstance ?? verifyRecordedDaemonInstance)(pid);
    if (verification === 'mismatch') {
      resolvedLogger.warn(
        'The recorded AgentRunner PID now belongs to an unrelated process — discarding the stale record',
        { pid },
      );
    } else {
      try {
        resolvedKill(pid, 'SIGTERM');
        resolvedLogger.info('Stopped running daemon', { pid });
      } catch {
        // Process may have exited between check and kill.
      }
    }
    await resolvedRemovePidFile();
  }

  if (!isWindowsTask) {
    await resolvedUnregisterAutostart();
  }

  resolvedLogger.info('Uninstall completed. Daemon service removed and autostart unregistered.');
};
