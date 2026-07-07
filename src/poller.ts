import { logger } from './logger.js';
import { DaemonApiClient } from './api-client.js';
import { runCleanup } from './utils/runner-cleanup.js';
import { runConventionSync } from './utils/convention-sync.js';
import { loadAuthPaths, saveAuthPath } from './utils/auth-path-store.js';
import { removeWorktree, resolveWorktreePath } from './utils/git-worktree.js';
import { existsSync } from 'node:fs';
import type { DaemonTrigger, RuntimeConfig } from './types.js';
import { maybeAutoUpdate } from './utils/auto-update.js';
import { executeRestartRequest } from './daemon-control.js';
import { createPowerSaveBlocker, type PowerSaveBlocker } from './utils/power-save-blocker.js';

type TriggerHandlerFactory = (
  onAuthPathDiscovered: (authPath: string) => void,
) => (trigger: DaemonTrigger) => Promise<void>;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONVENTION_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

// 한 polling cycle의 결과.
// - ACTIVE: 처리할 일이 있었다(pending claim/실행, 고아 취소, 워크트리 제거, restart 중 하나 이상).
// - IDLE: 순수 idle cycle(또는 cycle 실패) — 백오프 대상.
// - SKIPPED: 진행 중인 cycle에 의해 재진입이 억제됨 — 스케줄링에 반영하지 않는다.
type PollCycleOutcome = 'ACTIVE' | 'IDLE' | 'SKIPPED';

type PollingDependencies = {
  createClient?: (
    config: RuntimeConfig,
  ) => Pick<
    DaemonApiClient,
    | 'fetchPollState'
    | 'claimTrigger'
    | 'updateTriggerStatus'
    | 'reportWorktreeStatus'
    | 'notifyUpdate'
    | 'ackRestartRequest'
  >;
  runCleanup?: (authPath: string) => Promise<void>;
  runConventionSync?: (authPath: string) => Promise<void>;
  removeWorktree?: typeof removeWorktree;
  maybeAutoUpdate?: typeof maybeAutoUpdate;
  executeRestartRequest?: typeof executeRestartRequest;
  setTimeout?: typeof global.setTimeout;
  clearTimeout?: typeof global.clearTimeout;
  processOn?: (event: NodeJS.Signals, listener: () => void) => void;
  processExit?: (code: number) => never;
  now?: () => number;
  keepAlive?: () => Promise<void>;
  loadAuthPaths?: () => string[];
  saveAuthPath?: (authPath: string) => string;
  powerSaveBlocker?: PowerSaveBlocker;
};

export const startPolling = async (
  config: RuntimeConfig,
  createHandler: TriggerHandlerFactory,
  dependencies: PollingDependencies = {},
): Promise<void> => {
  const client = dependencies.createClient?.(config) ?? new DaemonApiClient(config.apiUrl, config.daemonToken);
  const cleanupRunner = dependencies.runCleanup ?? runCleanup;
  const conventionSync = dependencies.runConventionSync ?? runConventionSync;
  const removeWorktreeFn = dependencies.removeWorktree ?? removeWorktree;
  const autoUpdate = dependencies.maybeAutoUpdate ?? maybeAutoUpdate;
  const performRestart = dependencies.executeRestartRequest ?? executeRestartRequest;
  const now = dependencies.now ?? Date.now;
  const registerTimeout = dependencies.setTimeout ?? global.setTimeout;
  const unregisterTimeout = dependencies.clearTimeout ?? global.clearTimeout;
  const registerSignal = dependencies.processOn ?? ((event, listener) => process.on(event, listener));
  const exitProcess = dependencies.processExit ?? ((code) => process.exit(code));
  const keepAlive =
    dependencies.keepAlive ??
    (() =>
      new Promise<void>(() => {
        // Keep process alive until shutdown signal.
      }));
  const loadPersistedAuthPaths = dependencies.loadAuthPaths ?? loadAuthPaths;
  const persistAuthPath = dependencies.saveAuthPath ?? saveAuthPath;
  // 절전 방지는 daemon polling lifecycle이 소유한다. daemon이 살아 있는 동안(폴링/대기/실행)
  // 절전을 막고, 종료 시 해제한다. (배터리/비 macOS는 유틸 내부에서 no-op)
  const powerSaveBlocker =
    dependencies.powerSaveBlocker ?? createPowerSaveBlocker({ enabled: config.preventSleepWhileBusy });
  let isPolling = false;

  const knownAuthPaths = new Set<string>(loadPersistedAuthPaths());
  let lastCleanupAt = 0;
  const lastConventionSyncAt = new Map<string, number>();

  const onAuthPathDiscovered = (authPath: string): void => {
    if (knownAuthPaths.has(authPath)) {
      return;
    }

    knownAuthPaths.add(authPath);
    try {
      persistAuthPath(authPath);
    } catch (error) {
      logger.warn('Failed to persist auth path', {
        authPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onTrigger = createHandler(onAuthPathDiscovered);

  const maybeRunCleanup = () => {
    const currentTime = now();
    if (currentTime - lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanupAt = currentTime;

    for (const authPath of knownAuthPaths) {
      void cleanupRunner(authPath).catch((error) => {
        logger.warn('Scheduled cleanup failed', {
          authPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const maybeRunConventionSync = () => {
    const currentTime = now();
    for (const authPath of knownAuthPaths) {
      const lastSync = lastConventionSyncAt.get(authPath) ?? 0;
      if (currentTime - lastSync < CONVENTION_SYNC_INTERVAL_MS) {
        continue;
      }
      lastConventionSyncAt.set(authPath, currentTime);
      void conventionSync(authPath).catch((error) => {
        logger.warn('Scheduled convention sync failed', {
          authPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  // 통합 snapshot에서 받은 고아 취소 대상 ID들을 개별 mutation으로 처리한다.
  const autoCancelOrphanedTriggers = async (triggerIds: string[]) => {
    for (const triggerId of triggerIds) {
      try {
        await client.updateTriggerStatus(triggerId, 'CANCELLED', 'Automatically cancelled: runner is no longer active');
        logger.info('Auto-cancelled orphaned trigger', { triggerId });
      } catch (error) {
        logger.warn('Failed to auto-cancel orphaned trigger', {
          triggerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // 통합 snapshot에서 받은 워크트리 제거 대상 트리거들을 개별 mutation으로 처리한다.
  const processWorktreeRemovals = async (triggers: DaemonTrigger[]) => {
    for (const trigger of triggers) {
      try {
        let removeSucceeded = false;
        const effectiveWorktreeId = trigger.worktreeId ?? trigger.id;
        let matchedAuthPath = false;
        for (const authPath of knownAuthPaths) {
          const worktreePath = resolveWorktreePath(authPath, effectiveWorktreeId);
          if (!existsSync(worktreePath)) {
            continue;
          }

          matchedAuthPath = true;
          try {
            removeWorktreeFn(authPath, worktreePath, effectiveWorktreeId);
            removeSucceeded = true;
            logger.info('Worktree removed for trigger', { triggerId: trigger.id, worktreePath });
            break;
          } catch (error) {
            const worktreeError = error instanceof Error ? error.message : String(error);
            logger.warn('Failed to remove worktree for trigger', {
              triggerId: trigger.id,
              authPath,
              worktreePath,
              error: worktreeError,
            });
            await client.reportWorktreeStatus(trigger.id, 'FAILED', worktreeError);
            break;
          }
        }

        if (removeSucceeded) {
          await client.reportWorktreeStatus(trigger.id, 'REMOVED');
        } else if (!matchedAuthPath) {
          logger.warn('Could not find authPath for worktree removal', {
            triggerId: trigger.id,
            worktreeId: effectiveWorktreeId,
          });
          await client.reportWorktreeStatus(trigger.id, 'REMOVED');
        }
      } catch (error) {
        logger.warn('Failed to remove worktree for trigger', {
          triggerId: trigger.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const pollOnce = async (): Promise<PollCycleOutcome> => {
    if (isPolling) {
      return 'SKIPPED';
    }

    isPolling = true;
    // 이번 cycle에 처리할 일이 있었는지. 순수 idle만 false로 남는다.
    let hadWork = false;
    try {
      maybeRunCleanup();
      maybeRunConventionSync();

      // 한 polling cycle의 세 read(고아 취소 대상 / 워크트리 제거 대상 / pending)를 통합
      // snapshot 1회 조회로 가져온다. 실패 시 아래 catch에서 polling cycle 전체가 실패
      // 처리되어 명확한 로그를 남긴다(조용히 pending 확인만 생략하지 않는다).
      const pollState = await client.fetchPollState();

      hadWork =
        pollState.data.orphanedCancelRequestedTriggerIds.length > 0 ||
        pollState.data.pendingWorktreeRemovals.length > 0;

      // 후속 mutation은 기존과 동일하게 개별 처리하며, 처리 순서도 보존한다.
      await autoCancelOrphanedTriggers(pollState.data.orphanedCancelRequestedTriggerIds);
      await processWorktreeRemovals(pollState.data.pendingWorktreeRemovals);

      const trigger = pollState.data.pendingTrigger;

      // 웹에서 요청된 재시작은 pending 작업 유무와 무관하게 우선 처리한다.
      // 서버는 ack가 도착할 때까지 플래그를 유지하므로, ack 실패 시에는 다음 폴링에서
      // 다시 시도되어 요청이 조용히 소실되지 않는다.
      if (pollState.meta?.restartRequested) {
        try {
          await client.ackRestartRequest();
        } catch (error) {
          logger.warn('Failed to ack restart request — will retry on next poll', {
            error: error instanceof Error ? error.message : String(error),
          });
          // ack 재시도를 base 간격으로 빠르게 잇기 위해 활동으로 취급한다.
          return 'ACTIVE';
        }

        performRestart({ processExit: exitProcess });
        return 'ACTIVE';
      }

      if (!trigger) {
        // idle 상태에서 자동 업데이트 시도
        try {
          await autoUpdate(pollState.meta, {
            onRunnerUpdated: (version) => client.notifyUpdate(version, 'runner'),
          });
        } catch (error) {
          logger.error('Auto-update check failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return hadWork ? 'ACTIVE' : 'IDLE';
      }

      const claim = await client.claimTrigger(trigger.id);
      if (claim.conflict) {
        logger.info('Trigger already claimed by another daemon', { triggerId: trigger.id });
        return 'ACTIVE';
      }

      if (!claim.ok) {
        logger.warn('Claim was rejected', { triggerId: trigger.id });
        return 'ACTIVE';
      }

      void onTrigger(trigger).catch((error) => {
        logger.error('Trigger handler execution failed', {
          triggerId: trigger.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return 'ACTIVE';
    } catch (error) {
      logger.error('Polling cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return hadWork ? 'ACTIVE' : 'IDLE';
    } finally {
      isPolling = false;
    }
  };

  // idle 적응형 백오프: 연속 idle cycle마다 다음 폴 간격을 선형 증가시키고
  // (base × (1 + idleStreak × 0.5), 상한 clamp), 활동이 감지되면 즉시 base로 리셋한다.
  let stopped = false;
  let idleStreak = 0;
  let pendingPollTimer: NodeJS.Timeout | null = null;

  const computeNextPollDelay = (outcome: 'ACTIVE' | 'IDLE'): number => {
    if (outcome === 'ACTIVE') {
      idleStreak = 0;
      return config.pollingIntervalMs;
    }
    idleStreak += 1;
    return Math.min(config.pollingIntervalMs * (1 + idleStreak * 0.5), config.maxPollingIntervalMs);
  };

  const runPollCycle = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    const outcome = await pollOnce();
    if (outcome === 'SKIPPED') {
      // 진행 중인 cycle이 완료 시점에 다음 폴을 예약하므로 여기서 이중 예약하지 않는다.
      return;
    }
    if (stopped) {
      return;
    }

    pendingPollTimer = registerTimeout(() => {
      void runPollCycle();
    }, computeNextPollDelay(outcome));
  };

  // daemon 시작과 함께 절전 방지를 한 번 acquire한다. polling cycle마다 반복하지 않는다.
  const releasePowerSaveBlocker = powerSaveBlocker.acquire('daemon-polling');

  logger.info('Daemon polling started', {
    apiUrl: config.apiUrl,
    pollingIntervalMs: config.pollingIntervalMs,
    maxPollingIntervalMs: config.maxPollingIntervalMs,
    timeoutMs: config.timeoutMs,
    runnerCmd: config.runnerCmd,
  });

  // 부트스트랩: 즉시 1회 폴 후 자기예약 루프가 다음 폴을 이어간다.
  await runPollCycle();

  const shutdown = () => {
    stopped = true;
    if (pendingPollTimer !== null) {
      unregisterTimeout(pendingPollTimer);
      pendingPollTimer = null;
    }
    releasePowerSaveBlocker();
    logger.info('Daemon stopped');
    exitProcess(0);
  };

  registerSignal('SIGINT', shutdown);
  registerSignal('SIGTERM', shutdown);

  await keepAlive();
  // keepAlive가 resolve되는 정상 종료 경로(주로 테스트)에서도 release를 보장한다. release는 idempotent하다.
  releasePowerSaveBlocker();
};
