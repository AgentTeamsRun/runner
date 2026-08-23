import { createRequire } from 'node:module';
import { runExecutableSync } from '../executable.js';
import { logger } from '../logger.js';
import type { PendingMeta } from '../types.js';
import {
  classifyInstallError,
  describeInstallError,
  requiresManualFix,
  type InstallFailureReason,
} from './npm-install-error.js';
import { canWriteGlobalNpmRoot as canWriteGlobalNpmRootDefault } from './npm-global-permission.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version?: string };

const CLI_PACKAGE = '@agentteams/cli';
const RUNNER_PACKAGE = '@agentteams/runner';

const COOLDOWN_MS = 60 * 60 * 1000; // 1시간
/**
 * 권한 차단·전역 bin 이름 충돌은 사용자가 직접 고치기 전에는 절대 풀리지 않는다. 1시간마다 같은
 * EACCES/EEXIST를 반복해도 얻는 것이 없으므로 대상 버전이 바뀔 때까지 24시간 대기한다.
 */
const MANUAL_FIX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * 설치 실패가 아직 해소되지 않았을 때 "이미 최신인지"만 확인하는 프로브 주기.
 * 설치 백오프(권한 실패 시 24시간)와 분리해, 사용자가 CLI를 직접 설치하면 최대 이 주기 안에
 * 차단 상태가 자가 해제되게 한다. `npm list -g`는 동기 실행이라 폴링마다 돌리지는 않는다.
 */
const FAILURE_PROBE_COOLDOWN_MS = 5 * 60 * 1000;

const PERMISSION_BLOCKED_HINT =
  'AgentRunner cannot write to the global npm directory, so auto-update is blocked. ' +
  'Install the update manually with elevated permissions, or switch npm to a user-level prefix.';

export type UpdateFailurePackage = 'cli' | 'runner';

export type UpdateFailureInput = {
  package: UpdateFailurePackage;
  version: string;
  reason: InstallFailureReason;
  message: string;
};

export type UpdateSuccessInput = {
  package: UpdateFailurePackage;
  version: string;
};

type AutoUpdateDeps = {
  runExecutableSync?: typeof runExecutableSync;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  now?: () => number;
  onUpdateSucceeded?: (input: UpdateSuccessInput) => Promise<void>;
  onUpdateFailed?: (input: UpdateFailureInput) => Promise<void>;
  /** 전역 npm 루트 쓰기 가능 여부 프리플라이트. 판정 불가는 true(fail-open)로 온다. */
  canWriteGlobalNpmRoot?: () => boolean;
};

let lastSuccessfulRunnerVersion: string | null = null;

/** 패키지별 마지막 설치 시도. 대상 버전이 바뀌면 쿨다운과 무관하게 즉시 다시 시도한다. */
const lastUpdateAttempts = new Map<UpdateFailurePackage, { at: number; targetVersion: string }>();
/** 사용자 조치 전까지 회복 불가로 판정된 (package, version). 대상 버전이 바뀌면 즉시 재시도할 수 있게 버전을 함께 들고 있는다. */
const manualFixBlockedVersions = new Map<UpdateFailurePackage, string>();
/** 아직 서버에 전달하지 못한 실패 보고. 설치 백오프와 무관하게 매 폴링마다 재시도한다. */
const pendingFailureReports = new Map<UpdateFailurePackage, UpdateFailureInput>();
/** 보고가 성공한 실패 식별자. 서버 중복 계약과 같은 (version, reason) 조합만 억제한다. */
const reportedFailures = new Map<UpdateFailurePackage, string>();
/** 아직 서버에 전달하지 못한 설치 성공 (package → version). 매 폴링마다 재시도한다. */
const pendingSuccessReports = new Map<UpdateFailurePackage, string>();
/**
 * 이미 최신인 패키지를 성공으로 보고한 (package → version).
 * 프로세스당 같은 조합을 한 번만 큐에 넣어 폴링마다 재보고하지 않는다.
 */
const upToDateReported = new Map<UpdateFailurePackage, string>();
/** 설치 백오프와 무관하게 돌린 "이미 최신인지" 프로브의 마지막 실행 시각(package → at). */
const lastFailureProbes = new Map<UpdateFailurePackage, number>();

/** 서버의 중복 억제 계약과 동일하게 (version, reason)까지 봐야 사유 전환이 다시 보고된다. */
const failureIdentity = (input: UpdateFailureInput): string => `${input.version}::${input.reason}`;

const getCurrentRunnerVersion = (): string => packageJson.version ?? '0.0.0';

const getInstalledCliVersion = (
  deps: Pick<Required<AutoUpdateDeps>, 'runExecutableSync' | 'logger'>,
): string | null => {
  try {
    const version = deps.runExecutableSync('npm', ['list', '-g', CLI_PACKAGE, '--depth=0', '--json']);
    const parsed = JSON.parse(version) as { dependencies?: Record<string, { version?: string }> };
    return parsed.dependencies?.[CLI_PACKAGE]?.version ?? null;
  } catch {
    return null;
  }
};

const needsUpdate = (currentVersion: string | null, latestVersion: string | null): boolean => {
  if (!currentVersion || !latestVersion) return false;
  return currentVersion !== latestVersion;
};

const installPackage = (
  packageName: string,
  version: string,
  deps: Pick<Required<AutoUpdateDeps>, 'runExecutableSync'>,
): void => {
  deps.runExecutableSync('npm', ['install', '-g', `${packageName}@${version}`]);
};

/** 사용자 조치 대기로 백오프 중인지 판정한다. 대상 버전이 바뀌었으면 백오프를 해제한다. */
const isManualFixBlocked = (pkg: UpdateFailurePackage, targetVersion: string): boolean =>
  manualFixBlockedVersions.get(pkg) === targetVersion;

/**
 * 설치를 시도해도 되는 시점인지 판정한다.
 *
 * 대상 버전이 직전 시도와 다르면 쿨다운(사용자 조치 대기 24시간 포함)을 무시하고 즉시 시도한다.
 * 권한·패키징 문제를 고친 새 버전이 나왔는데 최대 1시간을 기다리는 일을 막는다.
 */
const shouldAttemptInstall = (pkg: UpdateFailurePackage, targetVersion: string, now: number): boolean => {
  const lastAttempt = lastUpdateAttempts.get(pkg);
  if (!lastAttempt || lastAttempt.targetVersion !== targetVersion) return true;

  const cooldown = isManualFixBlocked(pkg, targetVersion) ? MANUAL_FIX_COOLDOWN_MS : COOLDOWN_MS;
  return now - lastAttempt.at >= cooldown;
};

/** 서버에 남아 있는 차단 상태를 아직 해제하지 못했는지 판정한다. */
const hasUnresolvedFailure = (pkg: UpdateFailurePackage): boolean =>
  manualFixBlockedVersions.has(pkg) || pendingFailureReports.has(pkg) || reportedFailures.has(pkg);

/**
 * 설치 백오프에 걸려 있어도 "이미 최신인지"만 확인해도 되는 시점인지 판정한다.
 *
 * 사용자가 안내대로 CLI를 직접 설치하면 설치 쿨다운(권한 실패 시 24시간)이 끝날 때까지 기다리지 않고
 * 자가 해제되어야 한다. 반대로 차단 상태가 없으면 프로브할 이유가 없으므로 설치 주기만 따른다.
 */
const shouldProbeWhileBlocked = (pkg: UpdateFailurePackage, now: number): boolean => {
  if (!hasUnresolvedFailure(pkg)) return false;

  const lastProbe = lastFailureProbes.get(pkg);
  return lastProbe === undefined || now - lastProbe >= FAILURE_PROBE_COOLDOWN_MS;
};

/** 프리플라이트가 판정 불가로 throw하면 fail-open — 기존처럼 설치를 시도한다. */
const resolveCanWriteGlobalNpmRoot = (deps: AutoUpdateDeps): boolean => {
  const check = deps.canWriteGlobalNpmRoot ?? canWriteGlobalNpmRootDefault;
  try {
    return check();
  } catch {
    return true;
  }
};

export const maybeAutoUpdate = async (
  meta: PendingMeta | undefined,
  deps: AutoUpdateDeps = {},
): Promise<{ cliUpdated: boolean; runnerUpdated: boolean }> => {
  if (!meta) return { cliUpdated: false, runnerUpdated: false };

  const resolvedRunExecutableSync = deps.runExecutableSync ?? runExecutableSync;
  const resolvedLogger = deps.logger ?? logger;
  const now = (deps.now ?? Date.now)();

  let cliUpdated = false;
  let runnerUpdated = false;

  /**
   * 실패를 미보고 큐에 넣는다. 전송은 설치 백오프와 분리된 `flushPendingReports`가 담당하므로,
   * 24시간 백오프에 걸린 뒤에도 다음 폴링마다 보고만 재시도된다.
   *
   * `blockedUntilManualFix`는 서버로 보내는 `reason`과 별개다 — bin 이름 충돌은 `UNKNOWN`으로
   * 보고되지만 사용자가 충돌 파일을 치우기 전까지는 재시도해도 소용없으므로 백오프 대상이다.
   */
  const recordFailure = (input: UpdateFailureInput, blockedUntilManualFix: boolean): void => {
    if (blockedUntilManualFix) {
      const alreadyBlocked = manualFixBlockedVersions.get(input.package) === input.version;
      manualFixBlockedVersions.set(input.package, input.version);
      if (!alreadyBlocked) {
        // 로그 폭주를 막기 위해 버전당 1회만 조치 안내를 남긴다.
        resolvedLogger.warn(input.reason === 'PERMISSION_DENIED' ? PERMISSION_BLOCKED_HINT : input.message, {
          package: input.package,
          targetVersion: input.version,
        });
      }
    }

    // 이미 보고에 성공한 것과 완전히 같은 (version, reason)이면 다시 보내지 않는다.
    if (reportedFailures.get(input.package) === failureIdentity(input)) return;
    pendingFailureReports.set(input.package, input);
  };

  /** 설치 성공을 미보고 큐에 넣는다. 서버는 이 보고로 해당 패키지의 실패 상태를 해제한다. */
  const recordSuccess = (pkg: UpdateFailurePackage, version: string): void => {
    manualFixBlockedVersions.delete(pkg);
    pendingFailureReports.delete(pkg);
    reportedFailures.delete(pkg);
    pendingSuccessReports.set(pkg, version);
    upToDateReported.set(pkg, version);
  };

  /**
   * 미보고 상태를 서버로 흘려보낸다. 설치 쿨다운과 무관하게 폴링마다 1회씩 재시도하고,
   * 전송에 성공한 것만 큐에서 지워 수렴시킨다.
   */
  const flushPendingReports = async (): Promise<void> => {
    if (deps.onUpdateFailed) {
      for (const [pkg, input] of [...pendingFailureReports.entries()]) {
        try {
          await deps.onUpdateFailed(input);
          pendingFailureReports.delete(pkg);
          reportedFailures.set(pkg, failureIdentity(input));
        } catch (reportError) {
          resolvedLogger.error('Failed to report auto-update failure', {
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      }
    }

    if (deps.onUpdateSucceeded) {
      for (const [pkg, version] of [...pendingSuccessReports.entries()]) {
        try {
          await deps.onUpdateSucceeded({ package: pkg, version });
          pendingSuccessReports.delete(pkg);
        } catch (notifyError) {
          resolvedLogger.error('Failed to notify update success', {
            package: pkg,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        }
      }
    }
  };

  /**
   * 설치 직전 프리플라이트 → 설치 → 실패 분류를 한 곳에서 처리한다.
   * 반환값은 설치 성공 여부다.
   */
  const tryInstall = (pkg: UpdateFailurePackage, packageName: string, version: string): boolean => {
    if (!resolveCanWriteGlobalNpmRoot(deps)) {
      // 실행해봐야 EACCES로 죽는다. `npm install -g`를 아예 실행하지 않는다.
      recordFailure(
        {
          package: pkg,
          version,
          reason: 'PERMISSION_DENIED',
          message: PERMISSION_BLOCKED_HINT,
        },
        true,
      );
      return false;
    }

    try {
      installPackage(packageName, version, { runExecutableSync: resolvedRunExecutableSync });
      recordSuccess(pkg, version);
      return true;
    } catch (error) {
      const reason = classifyInstallError(error);
      resolvedLogger.error(pkg === 'cli' ? 'CLI auto-update failed' : 'Runner auto-update failed', {
        error: error instanceof Error ? error.message : String(error),
        reason,
      });
      recordFailure(
        {
          package: pkg,
          version,
          reason,
          message: describeInstallError(error),
        },
        requiresManualFix(error),
      );
      return false;
    }
  };

  // CLI 업데이트
  if (meta.cliLatestVersion) {
    const canInstallCli = shouldAttemptInstall('cli', meta.cliLatestVersion, now);
    // 설치가 백오프에 걸려 있어도 차단 상태가 남아 있으면 최신 여부 확인만 따로 돌린다.
    const probeOnly = !canInstallCli && shouldProbeWhileBlocked('cli', now);

    if (canInstallCli || probeOnly) {
      if (canInstallCli) {
        lastUpdateAttempts.set('cli', { at: now, targetVersion: meta.cliLatestVersion });
      }
      lastFailureProbes.set('cli', now);

      const currentCliVersion = getInstalledCliVersion({
        runExecutableSync: resolvedRunExecutableSync,
        logger: resolvedLogger,
      });

      if (needsUpdate(currentCliVersion, meta.cliLatestVersion)) {
        if (canInstallCli) {
          resolvedLogger.info('Auto-updating CLI', {
            currentVersion: currentCliVersion,
            targetVersion: meta.cliLatestVersion,
          });

          if (tryInstall('cli', CLI_PACKAGE, meta.cliLatestVersion)) {
            cliUpdated = true;
            resolvedLogger.info('CLI auto-update completed', {
              version: meta.cliLatestVersion,
            });
          }
        }
      } else if (currentCliVersion !== null && upToDateReported.get('cli') !== meta.cliLatestVersion) {
        // 사용자가 직접 최신 CLI를 깐 경우 설치를 건너뛰므로, 성공 보고를 1회 보내 서버의
        // stale 실패 상태를 자가 해제한다. 로컬 실패 상태도 함께 지워 프로브를 수렴시킨다.
        // runner 패키지는 pendingVersion을 덮어쓰므로 같은 no-op 보고를 하지 않는다.
        recordSuccess('cli', meta.cliLatestVersion);
      }
    }
  }

  // Runner 업데이트
  if (meta.runnerLatestVersion && shouldAttemptInstall('runner', meta.runnerLatestVersion, now)) {
    lastUpdateAttempts.set('runner', { at: now, targetVersion: meta.runnerLatestVersion });
    const currentRunnerVersion = getCurrentRunnerVersion();

    const isAlreadyInstalled = lastSuccessfulRunnerVersion === meta.runnerLatestVersion;

    if (!isAlreadyInstalled && needsUpdate(currentRunnerVersion, meta.runnerLatestVersion)) {
      resolvedLogger.info('Auto-updating Runner', {
        currentVersion: currentRunnerVersion,
        targetVersion: meta.runnerLatestVersion,
      });

      if (tryInstall('runner', RUNNER_PACKAGE, meta.runnerLatestVersion)) {
        runnerUpdated = true;
        lastSuccessfulRunnerVersion = meta.runnerLatestVersion;
        resolvedLogger.info('Runner auto-update completed — restart required', {
          version: meta.runnerLatestVersion,
        });
      }
    }
  }

  // 성공·실패 보고는 설치 시도와 분리해 매 폴링마다 재시도한다.
  await flushPendingReports();

  return { cliUpdated, runnerUpdated };
};

/** 테스트용: 쿨다운 타이머와 실패 상태 리셋 */
export const resetAutoUpdateState = (): void => {
  lastSuccessfulRunnerVersion = null;
  lastUpdateAttempts.clear();
  manualFixBlockedVersions.clear();
  pendingFailureReports.clear();
  reportedFailures.clear();
  pendingSuccessReports.clear();
  upToDateReported.clear();
  lastFailureProbes.clear();
};
