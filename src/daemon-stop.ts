import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from './logger.js';
import {
  isProcessRunning,
  readDaemonPidRecord,
  removePidFile,
  verifyRecordedDaemonInstance,
  type DaemonPidRecord,
  type RecordedInstanceVerification,
} from './pid.js';
import { isAgentRunnerProcess } from './process-identity.js';
import { requestShutdown, type ShutdownChannelTarget, type ShutdownRequestOutcome } from './shutdown-channel.js';

/** 왜 정상 종료 대신 강제 종료로 넘어갔는지. 사용자에게 보이는 로그와 테스트가 구분해야 하는 값이다. */
export type ForcedStopReason =
  /** PID 기록에 종료 채널 정보가 없다 — 채널을 지원하지 않는 구버전 러너. */
  | 'no-channel'
  /** 채널에 연결할 수 없다 — 수신부가 열리지 않았거나 이미 닫혔다. */
  | 'unavailable'
  /** 수신부가 요청을 거부했다. */
  | 'rejected'
  /** 연결은 됐지만 승인 응답이 없다. */
  | 'timeout'
  /** 승인은 받았지만 제한 시간 안에 끝나지 않았다. */
  | 'graceful-timeout';

export type WindowsStopOutcome =
  /** 러너가 요청을 받아 실행을 취소·보고한 뒤 스스로 끝났다. */
  | { status: 'graceful'; pid: number }
  /** 정상 종료가 불가능해 프로세스 트리를 강제 종료했다. 진행 중이던 실행은 취소로 보고되지 않았다. */
  | { status: 'forced'; pid: number; reason: ForcedStopReason }
  /** 요청을 보내기 전에 이미 끝나 있었다. */
  | { status: 'already-exited'; pid: number }
  /** 기록된 PID가 지금은 무관한 프로세스다. 신호 없이 기록만 버렸다. */
  | { status: 'stale-record'; pid: number }
  /** `force: false`인데 정상 종료가 되지 않았다. 아무것도 강제 종료하지 않았다. */
  | { status: 'not-stopped'; pid: number; reason: ForcedStopReason };

export type StopWindowsDaemonDeps = {
  /** false면 정상 종료만 시도한다(작업 스케줄러가 뒤이어 트리를 정리하는 경로). 기본 true. */
  force?: boolean;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  readDaemonPidRecord?: () => Promise<DaemonPidRecord | null>;
  verifyRecordedDaemonInstance?: (pid: number) => Promise<RecordedInstanceVerification>;
  requestShutdown?: (target: ShutdownChannelTarget) => Promise<ShutdownRequestOutcome>;
  isProcessRunning?: (pid: number) => boolean;
  isAgentRunnerProcess?: (pid: number) => boolean;
  killProcessTree?: (pid: number) => void;
  removePidFile?: () => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  logger?: Pick<typeof logger, 'warn'>;
};

// 러너의 종료 루틴은 실행 정리를 최대 20초 기다린다(poller.ts의 shutdownTimeoutMs). 그 뒤 프로세스가
// 실제로 사라지기까지의 여유를 더한다.
const DEFAULT_GRACEFUL_TIMEOUT_MS = 30_000;
const DEFAULT_FORCE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

// 러너만 끝내면 그 아래 PowerShell 래퍼와 엔진이 고아로 남는다. /T로 트리 전체를 끝낸다.
const killWindowsProcessTree = (pid: number): void => {
  execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
};

/**
 * Windows에서 기록된 러너 인스턴스를 멈춘다. 먼저 종료 채널로 정상 종료를 요청하고, 그것이 불가능할 때만
 * 강제 종료한다.
 *
 * 강제 종료는 "이 PID가 정말 러너"라고 확인된 경우에만 한다: PID 기록의 시작 시각과 OS의 프로세스 시작 시각이
 * 맞거나(`verified`), 그것을 대조할 수 없을 때는 프로세스 명령줄이 러너의 것이어야 한다. 어느 쪽도 확인하지
 * 못하면 아무것도 죽이지 않고 실패를 던진다 — Windows는 PID를 적극적으로 재사용하므로, 확인하지 못한 PID를
 * 죽이면 사용자의 무관한 프로세스가 끝날 수 있다.
 */
export const stopWindowsDaemonInstance = async (
  pid: number,
  deps: StopWindowsDaemonDeps = {},
): Promise<WindowsStopOutcome> => {
  const resolvedLogger = deps.logger ?? logger;
  const processIsRunning = deps.isProcessRunning ?? isProcessRunning;
  const sleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const now = deps.now ?? (() => Date.now());

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = now() + timeoutMs;
    while (processIsRunning(pid)) {
      if (now() >= deadline) return false;
      await sleep(POLL_INTERVAL_MS);
    }
    return true;
  };

  const verification = await (deps.verifyRecordedDaemonInstance ?? verifyRecordedDaemonInstance)(pid);
  if (verification === 'mismatch') {
    resolvedLogger.warn(
      'The recorded AgentRunner PID now belongs to an unrelated process — discarding the stale record',
      { pid },
    );
    await (deps.removePidFile ?? removePidFile)();
    return { status: 'stale-record', pid };
  }

  if (!processIsRunning(pid)) {
    return { status: 'already-exited', pid };
  }

  const record = await (deps.readDaemonPidRecord ?? readDaemonPidRecord)();
  // 기록이 이미 교체 러너의 것이라면 그 토큰으로 이 PID에 요청하면 안 된다.
  const channelTarget: ShutdownChannelTarget | null =
    record && record.pid === pid && record.instanceId && record.controlToken
      ? { pid, instanceId: record.instanceId, controlToken: record.controlToken }
      : null;

  let reason: ForcedStopReason = 'no-channel';
  if (channelTarget) {
    const outcome = await (deps.requestShutdown ?? requestShutdown)(channelTarget);
    if (outcome === 'accepted') {
      if (await waitForExit(deps.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS)) {
        return { status: 'graceful', pid };
      }
      reason = 'graceful-timeout';
    } else {
      reason = outcome;
    }
  }

  // 요청이 닿지 않은 이유가 "방금 끝났기 때문"일 수 있다.
  if (!processIsRunning(pid)) {
    return { status: 'already-exited', pid };
  }

  if (deps.force === false) {
    return { status: 'not-stopped', pid, reason };
  }

  if (verification !== 'verified' && !(deps.isAgentRunnerProcess ?? isAgentRunnerProcess)(pid)) {
    throw new Error(
      `AgentRunner (pid ${pid}) did not accept a graceful stop [${reason}] and the process could not be confirmed ` +
        'to be AgentRunner, so it was not terminated. Check the process and stop it manually.',
    );
  }

  resolvedLogger.warn(
    'AgentRunner could not be stopped gracefully — terminating its process tree. Runs in progress were not reported as cancelled',
    { pid, reason },
  );
  try {
    (deps.killProcessTree ?? killWindowsProcessTree)(pid);
  } catch (error) {
    if (processIsRunning(pid)) {
      throw new Error(
        `Failed to terminate AgentRunner (pid ${pid}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!(await waitForExit(deps.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS))) {
    throw new Error(`Timed out waiting for AgentRunner process ${pid} to stop.`);
  }
  return { status: 'forced', pid, reason };
};
