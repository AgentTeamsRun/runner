import { emptyTokenUsage, type TokenUsage } from '../runners/token-usage.js';
import type { DaemonTrigger, RuntimeConfig, TriggerRuntimeAttachment } from '../types.js';
// 러너 타입 집합의 SSOT. `import type`이므로 dist에 런타임 의존이 남지 않는다(zero-dependency 유지).
import type { RunnerType } from '@agentteams/core-constants';
import { DaemonApiClient } from '../api-client.js';
import { createRunnerFactory } from '../runners/index.js';
import { TriggerLogReporter } from '../runners/log-reporter.js';
import { logger } from '../logger.js';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { resolveRunnerHistoryPaths } from '../utils/runner-history.js';
import { isGitRepo, createWorktree, preflightGitState } from '../utils/git-worktree.js';
import { resolveWorktreeAuthPath } from '../utils/resolve-member-repo.js';
import { resolveDiscoveredWorktreePath } from '../utils/discovered-worktree-store.js';
import { existsSync, realpathSync } from 'node:fs';
import { extractResultTextFromStreamJson } from '../runners/claude-code.js';
import { runOriginIssueSafeguard } from '../utils/origin-issue-safeguard.js';
import { computeLocalKey, resolveRepositoryOrigin } from '../utils/worktree-discovery.js';
import { normalizeRemoteUrl } from '../utils/resolve-member-repo.js';
import { checkRunnerWorkingDirectory } from '../utils/working-directory.js';
import {
  describeUnsupportedRunnerOptions,
  getRunnerDefaultIdleTimeoutMs,
  runnerSupportsEffort,
  runnerSupportsFastMode,
} from '../runners/capabilities.js';
import { isCauseBearingResultMessage, selectPreferredFailureMessage } from '../runners/failure-message.js';

function sanitizeErrorMessage(msg: string): string {
  return msg.replaceAll(homedir(), '~');
}

/** idle timeout 값을 고른 축. 사후 추적용으로 로그에 그대로 실린다. */
export type IdleTimeoutSource = 'trigger' | 'env' | 'runnerDefault' | 'globalDefault';

export type IdleTimeoutSelection = {
  idleTimeoutMs: number;
  source: IdleTimeoutSource;
};

type IdleTimeoutResolutionInput = {
  /** 이 실행에만 지정된 값. 라벨이 없거나 서버가 구버전이면 null이다. */
  triggerIdleTimeoutMs: number | null;
  /** config.idleTimeoutMs. 환경변수가 없으면 이미 전역 기본값이 들어 있다. */
  configuredIdleTimeoutMs: number;
  /** IDLE_TIMEOUT_MS가 실제로 설정됐는가. 위 값만으로는 "명시 30분"과 "기본 30분"을 구분할 수 없다. */
  isConfiguredIdleTimeoutExplicit: boolean;
  runnerDefaultIdleTimeoutMs?: number;
};

// 러너 옵션 해석은 이 한 곳에서만 한다(러너 파일은 이미 정해진 opts.idleTimeoutMs를 그대로 쓴다).
// 우선순위는 트리거 값 > 명시적 IDLE_TIMEOUT_MS > 엔진별 기본값 > 전역 기본값이다. 트리거 값이
// 없는 것은 오류가 아니라 "지정 없음"이므로 다음 축으로 넘긴다 — 구버전 서버와 기존 요청은 항상 null이다.
export const selectIdleTimeoutMs = (input: IdleTimeoutResolutionInput): IdleTimeoutSelection => {
  // 0 이하는 setTimeout이 즉시 발화해 모든 실행을 죽이므로 지정으로 취급하지 않는다.
  // 서버가 범위를 이미 검증하지만, 러너는 자기가 못 믿는 값으로 워치독을 무장하지 않는다.
  if (
    typeof input.triggerIdleTimeoutMs === 'number' &&
    Number.isFinite(input.triggerIdleTimeoutMs) &&
    input.triggerIdleTimeoutMs > 0
  ) {
    return { idleTimeoutMs: input.triggerIdleTimeoutMs, source: 'trigger' };
  }

  if (input.isConfiguredIdleTimeoutExplicit) {
    return { idleTimeoutMs: input.configuredIdleTimeoutMs, source: 'env' };
  }

  if (typeof input.runnerDefaultIdleTimeoutMs === 'number') {
    return { idleTimeoutMs: input.runnerDefaultIdleTimeoutMs, source: 'runnerDefault' };
  }

  return { idleTimeoutMs: input.configuredIdleTimeoutMs, source: 'globalDefault' };
};

type TriggerHandlerOptions = {
  config: RuntimeConfig;
  client: DaemonApiClient;
  onAuthPathDiscovered?: (authPath: string) => void;
};

type ReporterLike = Pick<TriggerLogReporter, 'start' | 'append' | 'stop'>;
type ReadHistoryFile = (path: string, encoding: BufferEncoding) => Promise<string>;
type WriteHistoryFile = (path: string, content: string) => Promise<void>;
type FetchAttachmentFile = (downloadUrl: string) => Promise<Uint8Array>;
type RemoveAttachmentDirectory = (path: string) => Promise<void>;

type TriggerHandlerDependencies = {
  createRunnerFactory?: typeof createRunnerFactory;
  createLogReporter?: (client: DaemonApiClient, triggerId: string) => ReporterLike;
  isGitRepo?: typeof isGitRepo;
  createWorktree?: typeof createWorktree;
  preflightGitState?: typeof preflightGitState;
  resolveWorktreeAuthPath?: typeof resolveWorktreeAuthPath;
  resolveDiscoveredWorktreePath?: (localKey: string) => string | null;
  pathExists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  resolveRepositoryOrigin?: (path: string) => string | null;
  readHistoryFile?: ReadHistoryFile;
  writeHistoryFile?: WriteHistoryFile;
  fetchAttachmentFile?: FetchAttachmentFile;
  removeAttachmentDirectory?: RemoveAttachmentDirectory;
  resolveRunnerHistoryPaths?: typeof resolveRunnerHistoryPaths;
  setIntervalFn?: typeof global.setInterval;
  clearIntervalFn?: typeof global.clearInterval;
  cancelPollIntervalMs?: number;
};

export const createTriggerHandler = (options: TriggerHandlerOptions, dependencies: TriggerHandlerDependencies = {}) => {
  const { config, client, onAuthPathDiscovered } = options;
  const createRunner = (dependencies.createRunnerFactory ?? createRunnerFactory)(config.runnerCmd);
  const checkIsGitRepo = dependencies.isGitRepo ?? isGitRepo;
  const createRunnerWorktree = dependencies.createWorktree ?? createWorktree;
  const runPreflightGitState = dependencies.preflightGitState ?? preflightGitState;
  const resolveMemberAuthPath = dependencies.resolveWorktreeAuthPath ?? resolveWorktreeAuthPath;
  const resolveDiscoveredPath = dependencies.resolveDiscoveredWorktreePath ?? resolveDiscoveredWorktreePath;
  const pathExists = dependencies.pathExists ?? existsSync;
  const resolveRealpath = dependencies.realpath ?? realpathSync;
  const resolveOrigin = dependencies.resolveRepositoryOrigin ?? resolveRepositoryOrigin;

  /// 메인 체크아웃 경로를 canonical 형태로 해석해 그 해시를 서버에 보고한다(best-effort).
  /// realpath 실패(경로 부재 등)는 보고 자체를 건너뛴다 — 정규화되지 않은 경로의 해시를 보내면
  /// 같은 폴더가 두 개의 서로 다른 키를 갖게 되어 두 실행이 한 폴더에 겹칠 수 있다.
  const reportCheckoutIdentity = async (agentConfigId: string, authPath: string): Promise<void> => {
    let canonicalPath: string;
    try {
      canonicalPath = resolveRealpath(authPath);
    } catch (error) {
      logger.warn('Skipped checkout identity report: could not canonicalize authPath', {
        agentConfigId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      await client.reportCheckout?.(agentConfigId, computeLocalKey(canonicalPath));
    } catch (error) {
      logger.warn('Failed to report checkout identity', {
        agentConfigId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const createLogReporter =
    dependencies.createLogReporter ??
    ((apiClient: DaemonApiClient, triggerId: string): ReporterLike => new TriggerLogReporter(apiClient, triggerId));
  const readHistoryFile: ReadHistoryFile =
    dependencies.readHistoryFile ?? ((path, encoding) => readFile(path, encoding));
  const writeHistoryFile: WriteHistoryFile =
    dependencies.writeHistoryFile ??
    (async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    });
  const fetchAttachmentFile: FetchAttachmentFile =
    dependencies.fetchAttachmentFile ??
    (async (downloadUrl) => {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Attachment download failed (${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    });
  const removeAttachmentDirectory: RemoveAttachmentDirectory =
    dependencies.removeAttachmentDirectory ??
    (async (path) => {
      await rm(path, { recursive: true, force: true });
    });
  const resolveHistoryPaths = dependencies.resolveRunnerHistoryPaths ?? resolveRunnerHistoryPaths;
  const maxHistoryLength = 200000;
  const fallbackOutputMaxLength = 8000;
  const setIntervalFn = dependencies.setIntervalFn ?? global.setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? global.clearInterval;
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? 2000;
  const stripUtf8Bom = (content: string): string => content.replace(/^\uFEFF/, '');
  const currentHistoryPathPlaceholder = '{{AGENTRUNNER_CURRENT_HISTORY_PATH}}';
  const parentHistoryPathPlaceholder = '{{AGENTRUNNER_PARENT_HISTORY_PATH}}';

  // The web UI surfaces user-facing questions by parsing the `### Questions for User`
  // heading out of the reported history (extractQuestionsForUser). A history file
  // missing the section silently drops questions, so guarantee it at report time.
  const questionsForUserHeadingPattern = /^###\s+Questions for User\s*$/im;
  const questionsForUserFallbackSection = '\n\n### Questions for User\nNone';

  const ensureQuestionsForUserSection = (markdown: string): { markdown: string; normalized: boolean } => {
    if (questionsForUserHeadingPattern.test(markdown)) {
      return { markdown, normalized: false };
    }
    const truncated = markdown.slice(0, maxHistoryLength - questionsForUserFallbackSection.length);
    return { markdown: `${truncated}${questionsForUserFallbackSection}`, normalized: true };
  };

  const sanitizeAttachmentFileName = (fileName: string): string => {
    const sanitized = fileName
      .normalize('NFKD')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.\-]+/g, '')
      .replace(/-$/g, '')
      .slice(0, 120);
    return sanitized.length > 0 ? sanitized : 'attachment';
  };

  const assertInsideWorkspace = (workspaceRoot: string, targetPath: string): void => {
    const relativePath = relative(resolve(workspaceRoot), resolve(targetPath));
    if (
      relativePath === '' ||
      (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
    ) {
      return;
    }
    throw new Error(`Attachment path escaped runner workspace: ${targetPath}`);
  };

  const downloadRuntimeAttachments = async (
    attachments: TriggerRuntimeAttachment[] | undefined,
    workspaceRoot: string | null,
    triggerId: string,
  ): Promise<Array<TriggerRuntimeAttachment & { localPath: string }>> => {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    if (!workspaceRoot) {
      throw new Error('Cannot deliver attachments because runner workspace path is not configured.');
    }

    const attachmentDir = join(workspaceRoot, '.agentteams', 'runner', 'attachments', triggerId);
    assertInsideWorkspace(workspaceRoot, attachmentDir);
    await mkdir(attachmentDir, { recursive: true });

    const downloaded: Array<TriggerRuntimeAttachment & { localPath: string }> = [];
    for (const [index, attachment] of attachments.entries()) {
      const fileName = `${String(index + 1).padStart(2, '0')}-${attachment.id.slice(0, 8)}-${sanitizeAttachmentFileName(attachment.originalName)}`;
      const localPath = join(attachmentDir, fileName);
      assertInsideWorkspace(workspaceRoot, localPath);
      const bytes = await fetchAttachmentFile(attachment.downloadUrl);
      await writeFile(localPath, bytes);
      await access(localPath);
      downloaded.push({ ...attachment, localPath });
    }

    return downloaded;
  };

  const formatBytes = (size: number): string => `${size} bytes`;

  const appendAttachmentSection = (
    runnerPrompt: string,
    attachments: Array<TriggerRuntimeAttachment & { localPath: string }>,
  ): string => {
    if (attachments.length === 0) {
      return runnerPrompt;
    }

    const lines = [
      '## Attached Files',
      'The user attached the following files. Read them from these local paths when they are relevant to the request.',
      ...attachments.flatMap((attachment, index) => [
        `${index + 1}. ${attachment.originalName}`,
        `   - MIME type: ${attachment.mimeType}`,
        `   - Size: ${formatBytes(attachment.size)}`,
        `   - Local path: ${attachment.localPath}`,
      ]),
    ];

    return `${runnerPrompt.trimEnd()}\n\n${lines.join('\n')}`;
  };

  const resolveRunnerPrompt = (runnerPrompt: string, currentPath: string | null, parentPath: string | null): string => {
    return runnerPrompt
      .replaceAll(currentHistoryPathPlaceholder, currentPath ?? '(unavailable: authPath not configured)')
      .replaceAll(parentHistoryPathPlaceholder, parentPath ?? '(unavailable: authPath not configured)');
  };

  // 히스토리 파일을 읽어 사용할 마크다운을 돌려준다. 파일이 없거나 비어있으면 null.
  // 읽기 실패와 "내용 없음"만 null로 합치고, 업로드(네트워크/권한)와는 분리한다 —
  // 업로드 실패를 "파일 없음"으로 오인해 stdout 폴백으로 덮어쓰는 손상을 막기 위함.
  const loadHistoryMarkdown = async (historyPath: string | null): Promise<string | null> => {
    if (!historyPath) {
      return null;
    }
    try {
      const content = await readHistoryFile(historyPath, 'utf8');
      const markdown = stripUtf8Bom(content).trim();
      return markdown.length === 0 ? null : markdown;
    } catch (error) {
      logger.warn('Failed to read runner history file', {
        historyPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // 히스토리를 서버에 보고한다. 러너가 파일을 썼으면 그 파일을, 없으면(그리고 fallback이
  // 주어지면) stdout 폴백을 생성·저장해 업로드한다. 업로드 실패는 러너 성공을 뒤집지 않고,
  // 로컬 히스토리 파일도 보존한다(경고만 남김).
  const reportHistory = async (
    triggerId: string,
    historyPath: string | null,
    reporter: ReporterLike | null,
    fallback?: { outputText: string; errorMessage?: string },
  ): Promise<{ uploadedHistoryFile: boolean; hasHistoryFile: boolean }> => {
    const historyMarkdown = await loadHistoryMarkdown(historyPath);
    // 러너가 직접 쓴 온전한 히스토리 "파일"이 서버까지 업로드됐는지. stdout 폴백은 작업 완료를
    // 보장하지 못하므로 제외한다. idle 타임아웃을 NEEDS_REVIEW로 강등할지 판단하는 근거가 된다.
    const hasHistoryFile = historyMarkdown !== null;
    let historyForUpload: string | null = null;

    if (historyMarkdown !== null) {
      const { markdown, normalized } = ensureQuestionsForUserSection(historyMarkdown.slice(0, maxHistoryLength));
      historyForUpload = markdown;
      if (normalized) {
        // 관측(1단계): 러너가 가이드 위임 후에도 필수 섹션을 누락하는 빈도를 결과 상세 로그 탭에서
        // 확인하기 위한 신호. 잦으면 프롬프트 인라인 강조 복구 또는 서버 집계(2단계)를 검토한다.
        reporter?.append(
          'WARN',
          "History file was missing the '### Questions for User' section; appended 'None' to preserve the user-question channel.",
        );
      }
    } else if (fallback && fallback.outputText.trim().length > 0) {
      // 러너가 히스토리 파일을 안 쓴 경우에만 stdout 폴백으로 대체한다.
      const parsedOutput = extractResultTextFromStreamJson(fallback.outputText);
      historyForUpload = buildFallbackHistory(parsedOutput, fallback.errorMessage);
      if (historyPath) {
        await writeHistoryFile(historyPath, historyForUpload);
      }
      reporter?.append('WARN', 'Runner did not write a history file. Captured stdout was stored as fallback history.');
    }

    if (historyForUpload === null) {
      return { uploadedHistoryFile: false, hasHistoryFile };
    }

    try {
      await client.updateTriggerHistory(triggerId, historyForUpload);
      return { uploadedHistoryFile: hasHistoryFile, hasHistoryFile };
    } catch (error) {
      // 히스토리 업로드 실패는 러너 성공을 뒤집지 않는다. 로컬 파일을 보존하고 경고만 남긴다.
      logger.warn('Failed to upload runner history; local history file preserved', {
        triggerId,
        historyPath,
        error: error instanceof Error ? error.message : String(error),
      });
      reporter?.append('WARN', 'Failed to upload runner history to the server. The local history file is preserved.');
      return { uploadedHistoryFile: false, hasHistoryFile };
    }
  };

  const buildFallbackHistory = (outputText: string, errorMessage?: string): string => {
    const summaryLine = errorMessage
      ? `- Runner terminated with error: ${errorMessage}`
      : '- Runner exited without writing the required history file (flagged for review).';
    const trimmed = outputText.trim();
    if (trimmed.length === 0) {
      return ['### Summary', summaryLine, '- No stdout captured.', '', '### Questions for User', 'None'].join('\n');
    }

    const truncated =
      trimmed.length > fallbackOutputMaxLength
        ? trimmed.slice(0, fallbackOutputMaxLength) + '\n- *(truncated)*'
        : trimmed;

    return [
      '### Summary',
      summaryLine,
      '- Agent output (history file not written):',
      '',
      truncated,
      '',
      '### Questions for User',
      'None',
    ].join('\n');
  };

  const restoreParentHistoryFromServer = async (
    parentHistoryPath: string | null,
    parentHistoryMarkdown: string | null,
  ): Promise<void> => {
    const normalizedMarkdown = stripUtf8Bom(parentHistoryMarkdown ?? '').trim();

    if (!parentHistoryPath || normalizedMarkdown.length === 0) {
      return;
    }

    await writeHistoryFile(parentHistoryPath, normalizedMarkdown.slice(0, maxHistoryLength));
  };

  const reportWorktreeFailure = async (
    triggerId: string,
    reason: string,
    reporter: ReporterLike | null,
  ): Promise<void> => {
    reporter?.append('ERROR', reason);
    try {
      await client.reportWorktreeStatus(triggerId, 'FAILED', sanitizeErrorMessage(reason));
    } catch (error) {
      logger.warn('Failed to report worktree failure status', {
        triggerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return async (trigger: DaemonTrigger): Promise<void> => {
    let logReporter: ReporterLike | null = null;
    let currentHistoryPath: string | null = null;
    let cancelInterval: NodeJS.Timeout | null = null;
    let attachmentDir: string | null = null;
    let collectedUsage: TokenUsage | undefined;
    const cancelController = new AbortController();

    try {
      if (trigger.parentTriggerId && /[\/\\]|\.\./.test(trigger.parentTriggerId)) {
        throw new Error('Invalid parentTriggerId: path traversal characters detected');
      }

      logger.info('Trigger execution started', {
        triggerId: trigger.id,
        runnerType: trigger.runnerType,
      });

      const runtime = await client.fetchTriggerRuntime(trigger.id);
      logReporter = createLogReporter(client, trigger.id);
      const activeLogReporter = logReporter;
      activeLogReporter.start();
      activeLogReporter.append('INFO', `Trigger started with runner ${trigger.runnerType}.`);

      if (runtime.authPath && onAuthPathDiscovered) {
        onAuthPathDiscovered(runtime.authPath);
      }

      // 이 러너에서 이 AgentConfig의 메인 체크아웃이 실제로 어느 폴더인지 서버에 알린다.
      // 서버는 러너 파일시스템을 볼 수 없어 authPath 문자열만으로는 심링크·대소문자 별칭을 풀 수 없고,
      // 그 판별 실패는 "같은 폴더를 다른 폴더로 오판"(두 실행이 겹치는 방향)이라 실행 직렬화를
      // 과잉으로 유지할 수밖에 없다. canonical 경로의 해시만 보내고 절대 경로는 보내지 않는다.
      //
      // 워크트리 실행에서도 authPath는 메인 체크아웃 경로 그대로이므로 함께 보고한다.
      // 실패해도 실행을 막지 않는다 — 서버는 미보고를 "모름 = 직렬화"(안전 방향)로 처리한다.
      if (runtime.authPath) {
        void reportCheckoutIdentity(runtime.agentConfigId, runtime.authPath);
      }

      logger.info('Trigger runtime fetched', {
        triggerId: trigger.id,
        agentConfigId: runtime.agentConfigId,
        hasAuthPath: Boolean(runtime.authPath),
      });
      activeLogReporter.append('INFO', `Runtime fetched (agentConfigId=${runtime.agentConfigId}).`);

      let cancelRequested = false;
      let cancelCheckInFlight = false;
      const checkCancelRequested = async () => {
        if (cancelRequested || cancelCheckInFlight) {
          return;
        }

        cancelCheckInFlight = true;
        try {
          const requested = await client.isTriggerCancelRequested(trigger.id);
          if (requested) {
            cancelRequested = true;
            activeLogReporter.append('WARN', 'Cancellation requested by user. Stopping runner.');
            cancelController.abort();
          }
        } catch (error) {
          logger.warn('Failed to fetch trigger cancel status', {
            triggerId: trigger.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          cancelCheckInFlight = false;
        }
      };
      const startCancelPolling = async () => {
        if (cancelInterval) return;
        await checkCancelRequested();
        cancelInterval = setIntervalFn(() => {
          void checkCancelRequested();
        }, cancelPollIntervalMs);
      };

      let effectiveAuthPath = runtime.authPath;
      const shouldPreflightGitState = runtime.planType != null && Array.isArray(runtime.expectedCommits);
      const assertGitStateAvailable = async (repoPath: string) => {
        if (!shouldPreflightGitState) return;
        await startCancelPolling();
        cancelController.signal.throwIfAborted();
        const { missing, baseCommit } = await runPreflightGitState({
          repoPath,
          baseBranch: runtime.baseBranch,
          expectedCommits: runtime.expectedCommits,
          signal: cancelController.signal,
        });
        cancelController.signal.throwIfAborted();
        if (missing.length === 0) return baseCommit;
        const listing = missing.map((item) => `${item.kind}=${item.ref}`).join(', ');
        const reason = `GIT_STATE_UNAVAILABLE: missing ${listing}`;
        activeLogReporter.append('ERROR', reason);
        throw new Error(reason);
      };

      if (runtime.discoveredWorktreeLocalKey) {
        // 발견(discovered) worktree 재사용 실행.
        // managed createWorktree/remove lifecycle을 우회하고, 로컬 매핑 경로를 재검증해 그대로 cwd로 쓴다.
        // worktree를 새로 생성하거나 제거하지 않으며, 외부 소유권(디렉터리·브랜치)을 변경하지 않는다.
        const mappedPath = resolveDiscoveredPath(runtime.discoveredWorktreeLocalKey);
        const expectedRemote = runtime.repositoryRemoteUrl ? normalizeRemoteUrl(runtime.repositoryRemoteUrl) : null;
        let canonicalPath: string | null = null;
        try {
          canonicalPath = mappedPath ? resolveRealpath(mappedPath) : null;
        } catch {
          canonicalPath = null;
        }
        const mappedLocalKey = canonicalPath ? computeLocalKey(canonicalPath) : null;
        const mappedRemote = canonicalPath ? resolveOrigin(canonicalPath) : null;
        if (
          !mappedPath ||
          !canonicalPath ||
          !pathExists(canonicalPath) ||
          !checkIsGitRepo(canonicalPath) ||
          mappedLocalKey !== runtime.discoveredWorktreeLocalKey ||
          !expectedRemote ||
          mappedRemote !== expectedRemote
        ) {
          // 실행 직전 부재/무효 → Runner CLI 시작 전에 명확히 실패한다.
          // (레지스트리 MISSING 전이는 다음 discovery 정합화 cycle에서 반영된다.)
          const reason =
            'Discovered worktree is missing on this runner (it may have been removed by another tool); run aborted before start.';
          logger.warn('Discovered worktree missing at execution time', {
            triggerId: trigger.id,
            hasMapping: Boolean(mappedPath),
            localKeyMatches: mappedLocalKey === runtime.discoveredWorktreeLocalKey,
            repositoryMatches: Boolean(expectedRemote) && mappedRemote === expectedRemote,
          });
          activeLogReporter.append('ERROR', reason);
          throw new Error(reason);
        }
        await assertGitStateAvailable(canonicalPath);
        effectiveAuthPath = canonicalPath;
        if (onAuthPathDiscovered) {
          // 발견 worktree의 소유 저장소 경로도 known으로 등록해 두면 cleanup/convention sync 범위에 포함된다.
          onAuthPathDiscovered(canonicalPath);
        }
        activeLogReporter.append('INFO', `Reusing discovered worktree (read-only ownership) at ${canonicalPath}.`);
        logger.info('Reusing discovered worktree for trigger', { triggerId: trigger.id, worktreePath: canonicalPath });
      } else if (runtime.useWorktree) {
        if (!runtime.authPath) {
          const reason = 'Worktree requested but authPath is not configured.';
          logger.warn('Worktree requested but authPath is not configured', {
            triggerId: trigger.id,
          });
          await reportWorktreeFailure(trigger.id, reason, activeLogReporter);
          throw new Error(reason);
        }

        let worktreeRepoPath = runtime.authPath;

        if (!checkIsGitRepo(runtime.authPath)) {
          // 구버전 API는 repositoryRemoteUrl 필드 자체가 없다(undefined). 그 경우
          // 멤버 repo 해석을 시도하지 않고 기존 실패 동작을 그대로 유지한다.
          if (runtime.repositoryRemoteUrl === undefined) {
            const reason = `Not a git repository: ${runtime.authPath}`;
            logger.warn('Worktree requested but authPath is not a git repo', {
              triggerId: trigger.id,
              authPath: runtime.authPath,
            });
            await reportWorktreeFailure(trigger.id, reason, activeLogReporter);
            throw new Error(reason);
          }

          const resolution = resolveMemberAuthPath(runtime.authPath, runtime.repositoryRemoteUrl);
          if ('error' in resolution) {
            logger.warn('Worktree requested but member repository resolution failed', {
              triggerId: trigger.id,
              authPath: runtime.authPath,
              repositoryId: runtime.repositoryId ?? null,
            });
            await reportWorktreeFailure(trigger.id, resolution.error, activeLogReporter);
            throw new Error(resolution.error);
          }

          worktreeRepoPath = resolution.path;
          // 제거 lifecycle 계약: poller는 knownAuthPaths의 각 경로에 resolveWorktreePath를
          // 적용해 제거 대상을 찾으므로, 워크트리가 실제로 생성되는 멤버 repo 경로도
          // 등록해야 한다. 비-git 루트만 등록하면 제거가 경로를 못 찾은 채 REMOVED로
          // 보고되어 워크트리와 worktree/* 브랜치가 영구히 남는다.
          if (onAuthPathDiscovered) {
            onAuthPathDiscovered(worktreeRepoPath);
          }
          activeLogReporter.append('INFO', `Resolved member repository ${worktreeRepoPath} for worktree creation.`);
          logger.info('Resolved member repository for worktree', {
            triggerId: trigger.id,
            authPath: runtime.authPath,
            memberRepoPath: worktreeRepoPath,
          });
        }

        const baseCommit = await assertGitStateAvailable(worktreeRepoPath);

        try {
          const worktreePath = createRunnerWorktree(worktreeRepoPath, {
            worktreeId: runtime.worktreeId ?? trigger.id,
            baseBranch: baseCommit ?? runtime.baseBranch,
          });
          effectiveAuthPath = worktreePath;
          await client.reportWorktreeStatus(trigger.id, 'ACTIVE');
          activeLogReporter.append('INFO', `Worktree created at ${worktreePath}.`);
          logger.info('Worktree created for trigger', {
            triggerId: trigger.id,
            worktreePath,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn('Failed to create worktree', {
            triggerId: trigger.id,
            error: reason,
          });
          await reportWorktreeFailure(trigger.id, reason, activeLogReporter);
          throw new Error(reason);
        }
      } else {
        // RunnerBox를 끄고 authPath에서 바로 실행하는 경로에만 적용한다. discovered worktree와
        // managed worktree 분기는 각자의 존재/유효성 검증을 이미 수행하므로 중복 판정하지 않는다.
        // 이 판정은 히스토리·첨부 쓰기와 러너의 mkdir(recursive)보다 먼저 일어나야, 다른 머신의
        // 트리거를 집어갔을 때 빈 디렉터리를 만들어 놓고 도는 조용한 오실행이 사라진다.
        const workingDirectoryCheck = checkRunnerWorkingDirectory(effectiveAuthPath, {
          pathExists,
          isGitRepo: checkIsGitRepo,
          expectedProjectId: runtime.projectId,
        });
        if (!workingDirectoryCheck.valid) {
          logger.warn('Runner working directory validation failed', {
            triggerId: trigger.id,
            code: workingDirectoryCheck.code,
          });
          activeLogReporter.append('ERROR', workingDirectoryCheck.reason);
          throw new Error(workingDirectoryCheck.reason);
        }
        if (effectiveAuthPath) {
          await assertGitStateAvailable(effectiveAuthPath);
        }
      }

      const historyPaths = resolveHistoryPaths(effectiveAuthPath, trigger.id, trigger.parentTriggerId);
      currentHistoryPath = historyPaths.currentHistoryPath;
      await restoreParentHistoryFromServer(historyPaths.parentHistoryPath, runtime.parentHistoryMarkdown);
      if (effectiveAuthPath && runtime.attachments && runtime.attachments.length > 0) {
        attachmentDir = join(effectiveAuthPath, '.agentteams', 'runner', 'attachments', trigger.id);
      }
      const downloadedAttachments = await downloadRuntimeAttachments(
        runtime.attachments,
        effectiveAuthPath,
        trigger.id,
      );
      if (downloadedAttachments.length > 0) {
        activeLogReporter.append('INFO', `Downloaded ${downloadedAttachments.length} attachment(s) for runner access.`);
      }
      const runnerPrompt = appendAttachmentSection(
        resolveRunnerPrompt(runtime.runnerPrompt, historyPaths.currentHistoryPath, historyPaths.parentHistoryPath),
        downloadedAttachments,
      );

      const runner = createRunner(trigger.runnerType);
      // 구조화 로그 파서가 만든 RESULT 청크 중 실제 원인이 담긴 마지막 값. 러너의 stderr 마지막
      // 줄은 원인과 무관한 잡음("Reading additional input from stdin...")인 경우가 많아, 실패
      // 사유로는 이쪽 원문을 우선한다.
      let lastCauseBearingResultMessage: string | undefined;
      await startCancelPolling();
      const runnerFastMode = runnerSupportsFastMode(trigger.runnerType) ? trigger.fastMode : false;
      const runnerEffort = runnerSupportsEffort(trigger.runnerType) ? trigger.effort : null;
      const idleTimeout = selectIdleTimeoutMs({
        triggerIdleTimeoutMs: trigger.idleTimeoutMs,
        configuredIdleTimeoutMs: config.idleTimeoutMs,
        isConfiguredIdleTimeoutExplicit: config.isConfiguredIdleTimeoutExplicit === true,
        runnerDefaultIdleTimeoutMs: getRunnerDefaultIdleTimeoutMs(trigger.runnerType),
      });
      // 미지원 옵션 경고와 같은 결로, 실제 적용된 idle timeout과 그 값이 온 축을 남긴다. 타임아웃
      // 종료를 사후에 볼 때 "왜 이 길이였나"를 로그만으로 되짚을 수 있어야 한다.
      logger.info('Resolved runner idle timeout', {
        triggerId: trigger.id,
        runnerType: trigger.runnerType,
        idleTimeoutMs: idleTimeout.idleTimeoutMs,
        source: idleTimeout.source,
      });
      // 서버가 확정한 실행 옵션(model/fastMode/effort) 중 대상 러너가 소비하지 못하는 것을 무음으로
      // 폐기하지 않고 사용자 가시 경고(로그 리포터 WARN)로 승격한다. 러너별 지원 매트릭스는
      // runners/capabilities.ts의 단일 정의를 참조한다.
      for (const unsupported of describeUnsupportedRunnerOptions(trigger.runnerType, {
        model: trigger.model,
        fastMode: trigger.fastMode,
        effort: trigger.effort,
      })) {
        logger.warn('Runner option not supported by target runner; ignoring', {
          triggerId: trigger.id,
          runnerType: trigger.runnerType,
          option: unsupported.option,
        });
        activeLogReporter.append('WARN', unsupported.message);
      }
      // 절전 방지는 daemon polling lifecycle(poller)이 daemon-level로 소유하므로 trigger 실행 중에도 유지된다.
      const runResult = await runner.run({
        triggerId: trigger.id,
        prompt: runnerPrompt,
        authPath: effectiveAuthPath,
        apiKey: runtime.apiKey,
        apiUrl: config.apiUrl,
        teamId: runtime.teamId,
        projectId: runtime.projectId,
        timeoutMs: config.timeoutMs,
        idleTimeoutMs: idleTimeout.idleTimeoutMs,
        agentConfigId: runtime.agentConfigId,
        // 러너 인스턴스는 자기 타입을 모르므로 호출자가 실어 보낸다. 이 지점은 createRunner()가
        // 이미 성공한 뒤이고 팩토리가 SSOT에 없는 값을 throw로 거르므로, 좁히기는 안전하다.
        runnerType: trigger.runnerType as RunnerType,
        model: trigger.model,
        fastMode: runnerFastMode,
        effort: runnerEffort,
        signal: cancelController.signal,
        onStdoutChunk: (chunk, category, toolName) => {
          if (category === 'RESULT' && isCauseBearingResultMessage(chunk)) {
            lastCauseBearingResultMessage = chunk.trim();
          }
          activeLogReporter.append('INFO', chunk, category, toolName);
        },
        onStderrChunk: (chunk, category) => {
          activeLogReporter.append('WARN', chunk, category);
        },
      });
      collectedUsage = runResult.tokenUsage;
      if (cancelInterval) clearIntervalFn(cancelInterval);
      cancelInterval = null;
      logger.info('Trigger runner finished', {
        triggerId: trigger.id,
        exitCode: runResult.exitCode,
      });
      logReporter.append('INFO', `Runner finished with exitCode=${runResult.exitCode}.`);
      const { hasHistoryFile } = await reportHistory(trigger.id, currentHistoryPath, logReporter, {
        outputText: runResult.outputText ?? '',
        errorMessage: runResult.exitCode === 0 ? undefined : runResult.errorMessage,
      });

      // idle 워치독에 의해 종료됐지만 러너가 온전한 히스토리 파일을 남겼다면, 작업은 사실상
      // 완료됐는데 종료 시퀀스에서 행이 걸린 경우다(예: Antigravity print 모드 finalize 행).
      // hard-FAIL 대신 NEEDS_REVIEW로 강등해 사람이 산출물을 보고 승인/거부하도록 한다.
      // 산출물 존재 여부(hasHistoryFile)로 판단한다 — 서버 업로드 실패는 완료를 뒤집지 않는다.
      const idleTimedOutWithHistory = runResult.idleTimedOut === true && hasHistoryFile && !runResult.cancelled;
      if (idleTimedOutWithHistory) {
        // 사유는 빨간 Error 탭이 아니라 INFO 로그로 남긴다(소프트 상태라 에러 스타일은 부적절).
        logReporter.append(
          'INFO',
          'Runner idle-timed-out during shutdown but a complete history file was produced; flagged for human review (approve to mark DONE, reject to mark FAILED).',
        );
      }

      // exitCode 0이라도 러너가 필수 히스토리 파일을 안 썼다면 작업 완료를 보장할 수 없다(턴이
      // 산출물 작성 전에 끝났거나 모델이 마지막 쓰기 단계를 누락한 경우). DONE으로 단정하지 않고
      // NEEDS_REVIEW로 강등해 사람이 폴백(정제된 출력)을 보고 승인/거부하게 한다.
      const exitedCleanWithoutHistory = runResult.exitCode === 0 && !hasHistoryFile && !runResult.cancelled;
      if (exitedCleanWithoutHistory) {
        logReporter.append(
          'INFO',
          'Runner exited cleanly (exitCode=0) but did not write a history file; flagged for human review (approve to mark DONE, reject to mark FAILED).',
        );
      }

      await logReporter.stop();

      // 3차 방어: origin issue 자동 연결 안전장치 (fire-and-forget)
      void runOriginIssueSafeguard(trigger.prompt, currentHistoryPath, effectiveAuthPath).catch(() => {
        // Safeguard failure should never block trigger completion
      });

      const status = runResult.cancelled
        ? 'CANCELLED'
        : runResult.exitCode === 0
          ? hasHistoryFile
            ? 'DONE'
            : 'NEEDS_REVIEW'
          : idleTimedOutWithHistory
            ? 'NEEDS_REVIEW'
            : 'FAILED';
      const errorMessage =
        status === 'FAILED'
          ? selectPreferredFailureMessage({
              resultFailureDetail: lastCauseBearingResultMessage,
              runnerErrorMessage: runResult.errorMessage,
              lastOutput: runResult.lastOutput,
              exitCode: runResult.exitCode,
              idleTimedOut: runResult.idleTimedOut,
              timedOut: runResult.timedOut,
            })
          : status === 'CANCELLED'
            ? runResult.errorMessage || 'Runner cancelled by user'
            : undefined;
      await client.updateTriggerStatus(
        trigger.id,
        status,
        errorMessage ? sanitizeErrorMessage(errorMessage) : undefined,
        runResult.tokenUsage ?? emptyTokenUsage(trigger.runnerType),
      );
      logger.info('Trigger completed', {
        triggerId: trigger.id,
        status,
      });
    } catch (error) {
      if (cancelInterval) {
        clearIntervalFn(cancelInterval);
        cancelInterval = null;
      }
      logger.error('Trigger handling failed', {
        triggerId: trigger.id,
        error: error instanceof Error ? error.message : String(error),
      });

      try {
        logReporter?.append('ERROR', error instanceof Error ? error.message : String(error));
        await reportHistory(trigger.id, currentHistoryPath, logReporter);
        if (logReporter) {
          await logReporter.stop();
        }
        const rawErrorMsg = error instanceof Error ? error.message : String(error);
        await client.updateTriggerStatus(
          trigger.id,
          cancelController.signal.aborted ? 'CANCELLED' : 'FAILED',
          cancelController.signal.aborted ? 'Runner cancelled by user' : sanitizeErrorMessage(rawErrorMsg),
          collectedUsage ?? emptyTokenUsage(trigger.runnerType),
        );
      } catch (statusError) {
        logger.error('Failed to report trigger as FAILED', {
          triggerId: trigger.id,
          error: statusError instanceof Error ? statusError.message : String(statusError),
        });
      }
    } finally {
      if (attachmentDir) {
        try {
          await removeAttachmentDirectory(attachmentDir);
        } catch (cleanupError) {
          logger.warn('Failed to remove runner attachment directory', {
            triggerId: trigger.id,
            attachmentDir,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
    }
  };
};
