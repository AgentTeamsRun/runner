import type { DaemonTrigger, RuntimeConfig, TriggerRuntimeAttachment } from "../types.js";
import { DaemonApiClient } from "../api-client.js";
import { createRunnerFactory } from "../runners/index.js";
import { TriggerLogReporter } from "../runners/log-reporter.js";
import { logger } from "../logger.js";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { resolveRunnerHistoryPaths } from "../utils/runner-history.js";
import { isGitRepo, createWorktree } from "../utils/git-worktree.js";
import { extractResultTextFromStreamJson } from "../runners/claude-code.js";
import { runOriginIssueSafeguard } from "../utils/origin-issue-safeguard.js";

function sanitizeErrorMessage(msg: string): string {
  return msg.replaceAll(homedir(), '~');
}

type TriggerHandlerOptions = {
  config: RuntimeConfig;
  client: DaemonApiClient;
  onAuthPathDiscovered?: (authPath: string) => void;
};

type ReporterLike = Pick<TriggerLogReporter, "start" | "append" | "stop">;
type ReadHistoryFile = (path: string, encoding: BufferEncoding) => Promise<string>;
type WriteHistoryFile = (path: string, content: string) => Promise<void>;
type FetchAttachmentFile = (downloadUrl: string) => Promise<Uint8Array>;
type RemoveAttachmentDirectory = (path: string) => Promise<void>;

type TriggerHandlerDependencies = {
  createRunnerFactory?: typeof createRunnerFactory;
  createLogReporter?: (client: DaemonApiClient, triggerId: string) => ReporterLike;
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
  const createLogReporter = dependencies.createLogReporter ?? ((apiClient: DaemonApiClient, triggerId: string): ReporterLike => (
    new TriggerLogReporter(apiClient, triggerId)
  ));
  const readHistoryFile: ReadHistoryFile = dependencies.readHistoryFile ?? ((path, encoding) => readFile(path, encoding));
  const writeHistoryFile: WriteHistoryFile = dependencies.writeHistoryFile ?? (async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  });
  const fetchAttachmentFile: FetchAttachmentFile = dependencies.fetchAttachmentFile ?? (async (downloadUrl) => {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Attachment download failed (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  });
  const removeAttachmentDirectory: RemoveAttachmentDirectory = dependencies.removeAttachmentDirectory ?? (async (path) => {
    await rm(path, { recursive: true, force: true });
  });
  const resolveHistoryPaths = dependencies.resolveRunnerHistoryPaths ?? resolveRunnerHistoryPaths;
  const maxHistoryLength = 200000;
  const fallbackOutputMaxLength = 8000;
  const setIntervalFn = dependencies.setIntervalFn ?? global.setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? global.clearInterval;
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? 2000;
  const stripUtf8Bom = (content: string): string => content.replace(/^\uFEFF/, "");
  const currentHistoryPathPlaceholder = "{{AGENTRUNNER_CURRENT_HISTORY_PATH}}";
  const parentHistoryPathPlaceholder = "{{AGENTRUNNER_PARENT_HISTORY_PATH}}";

  // The web UI surfaces user-facing questions by parsing the `### Questions for User`
  // heading out of the reported history (extractQuestionsForUser). A history file
  // missing the section silently drops questions, so guarantee it at report time.
  const questionsForUserHeadingPattern = /^###\s+Questions for User\s*$/im;
  const questionsForUserFallbackSection = "\n\n### Questions for User\nNone";

  const ensureQuestionsForUserSection = (markdown: string): { markdown: string; normalized: boolean } => {
    if (questionsForUserHeadingPattern.test(markdown)) {
      return { markdown, normalized: false };
    }
    const truncated = markdown.slice(0, maxHistoryLength - questionsForUserFallbackSection.length);
    return { markdown: `${truncated}${questionsForUserFallbackSection}`, normalized: true };
  };

  const sanitizeAttachmentFileName = (fileName: string): string => {
    const sanitized = fileName
      .normalize("NFKD")
      .replace(/[^\w.\-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.\-]+/g, "")
      .replace(/-$/g, "")
      .slice(0, 120);
    return sanitized.length > 0 ? sanitized : "attachment";
  };

  const assertInsideWorkspace = (workspaceRoot: string, targetPath: string): void => {
    const relativePath = relative(resolve(workspaceRoot), resolve(targetPath));
    if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) {
      return;
    }
    throw new Error(`Attachment path escaped runner workspace: ${targetPath}`);
  };

  const downloadRuntimeAttachments = async (
    attachments: TriggerRuntimeAttachment[] | undefined,
    workspaceRoot: string | null,
    triggerId: string
  ): Promise<Array<TriggerRuntimeAttachment & { localPath: string }>> => {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    if (!workspaceRoot) {
      throw new Error("Cannot deliver attachments because runner workspace path is not configured.");
    }

    const attachmentDir = join(workspaceRoot, ".agentteams", "runner", "attachments", triggerId);
    assertInsideWorkspace(workspaceRoot, attachmentDir);
    await mkdir(attachmentDir, { recursive: true });

    const downloaded: Array<TriggerRuntimeAttachment & { localPath: string }> = [];
    for (const [index, attachment] of attachments.entries()) {
      const fileName = `${String(index + 1).padStart(2, "0")}-${attachment.id.slice(0, 8)}-${sanitizeAttachmentFileName(attachment.originalName)}`;
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
    attachments: Array<TriggerRuntimeAttachment & { localPath: string }>
  ): string => {
    if (attachments.length === 0) {
      return runnerPrompt;
    }

    const lines = [
      "## Attached Files",
      "The user attached the following files. Read them from these local paths when they are relevant to the request.",
      ...attachments.flatMap((attachment, index) => [
        `${index + 1}. ${attachment.originalName}`,
        `   - MIME type: ${attachment.mimeType}`,
        `   - Size: ${formatBytes(attachment.size)}`,
        `   - Local path: ${attachment.localPath}`,
      ]),
    ];

    return `${runnerPrompt.trimEnd()}\n\n${lines.join("\n")}`;
  };

  const resolveRunnerPrompt = (
    runnerPrompt: string,
    currentPath: string | null,
    parentPath: string | null
  ): string => {
    return runnerPrompt
      .replaceAll(currentHistoryPathPlaceholder, currentPath ?? "(unavailable: authPath not configured)")
      .replaceAll(parentHistoryPathPlaceholder, parentPath ?? "(unavailable: authPath not configured)");
  };

  // 히스토리 파일을 읽어 사용할 마크다운을 돌려준다. 파일이 없거나 비어있으면 null.
  // 읽기 실패와 "내용 없음"만 null로 합치고, 업로드(네트워크/권한)와는 분리한다 —
  // 업로드 실패를 "파일 없음"으로 오인해 stdout 폴백으로 덮어쓰는 손상을 막기 위함.
  const loadHistoryMarkdown = async (historyPath: string | null): Promise<string | null> => {
    if (!historyPath) {
      return null;
    }
    try {
      const content = await readHistoryFile(historyPath, "utf8");
      const markdown = stripUtf8Bom(content).trim();
      return markdown.length === 0 ? null : markdown;
    } catch (error) {
      logger.warn("Failed to read runner history file", {
        historyPath,
        error: error instanceof Error ? error.message : String(error)
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
    fallback?: { outputText: string; errorMessage?: string }
  ): Promise<void> => {
    const historyMarkdown = await loadHistoryMarkdown(historyPath);
    let historyForUpload: string | null = null;

    if (historyMarkdown !== null) {
      const { markdown, normalized } = ensureQuestionsForUserSection(
        historyMarkdown.slice(0, maxHistoryLength)
      );
      historyForUpload = markdown;
      if (normalized) {
        // 관측(1단계): 러너가 가이드 위임 후에도 필수 섹션을 누락하는 빈도를 결과 상세 로그 탭에서
        // 확인하기 위한 신호. 잦으면 프롬프트 인라인 강조 복구 또는 서버 집계(2단계)를 검토한다.
        reporter?.append(
          "WARN",
          "History file was missing the '### Questions for User' section; appended 'None' to preserve the user-question channel."
        );
      }
    } else if (fallback && fallback.outputText.trim().length > 0) {
      // 러너가 히스토리 파일을 안 쓴 경우에만 stdout 폴백으로 대체한다.
      const parsedOutput = extractResultTextFromStreamJson(fallback.outputText);
      historyForUpload = buildFallbackHistory(parsedOutput, fallback.errorMessage);
      if (historyPath) {
        await writeHistoryFile(historyPath, historyForUpload);
      }
      reporter?.append(
        "WARN",
        "Runner did not write a history file. Captured stdout was stored as fallback history."
      );
    }

    if (historyForUpload === null) {
      return;
    }

    try {
      await client.updateTriggerHistory(triggerId, historyForUpload);
    } catch (error) {
      // 히스토리 업로드 실패는 러너 성공을 뒤집지 않는다. 로컬 파일을 보존하고 경고만 남긴다.
      logger.warn("Failed to upload runner history; local history file preserved", {
        triggerId,
        historyPath,
        error: error instanceof Error ? error.message : String(error)
      });
      reporter?.append(
        "WARN",
        "Failed to upload runner history to the server. The local history file is preserved."
      );
    }
  };

  const buildFallbackHistory = (outputText: string, errorMessage?: string): string => {
    const summaryLine = errorMessage
      ? `- Runner terminated with error: ${errorMessage}`
      : "- Runner completed successfully but did not write the requested history file.";
    const trimmed = outputText.trim();
    if (trimmed.length === 0) {
      return [
        "### Summary",
        summaryLine,
        "- No stdout captured.",
        "",
        "### Questions for User",
        "None"
      ].join("\n");
    }

    const truncated = trimmed.length > fallbackOutputMaxLength
      ? trimmed.slice(0, fallbackOutputMaxLength) + "\n- *(truncated)*"
      : trimmed;

    return [
      "### Summary",
      summaryLine,
      "- Agent output (history file not written):",
      "",
      truncated,
      "",
      "### Questions for User",
      "None"
    ].join("\n");
  };

  const restoreParentHistoryFromServer = async (
    parentHistoryPath: string | null,
    parentHistoryMarkdown: string | null
  ): Promise<void> => {
    const normalizedMarkdown = stripUtf8Bom(parentHistoryMarkdown ?? "").trim();

    if (!parentHistoryPath || normalizedMarkdown.length === 0) {
      return;
    }

    await writeHistoryFile(parentHistoryPath, normalizedMarkdown.slice(0, maxHistoryLength));
  };

  return async (trigger: DaemonTrigger): Promise<void> => {
    let logReporter: ReporterLike | null = null;
    let currentHistoryPath: string | null = null;
    let cancelInterval: NodeJS.Timeout | null = null;
    let attachmentDir: string | null = null;

    try {
      if (trigger.parentTriggerId && /[\/\\]|\.\./.test(trigger.parentTriggerId)) {
        throw new Error('Invalid parentTriggerId: path traversal characters detected');
      }

      logger.info("Trigger execution started", {
        triggerId: trigger.id,
        runnerType: trigger.runnerType
      });

      const runtime = await client.fetchTriggerRuntime(trigger.id);
      logReporter = createLogReporter(client, trigger.id);
      const activeLogReporter = logReporter;
      activeLogReporter.start();
      activeLogReporter.append("INFO", `Trigger started with runner ${trigger.runnerType}.`);

      if (runtime.authPath && onAuthPathDiscovered) {
        onAuthPathDiscovered(runtime.authPath);
      }

      logger.info("Trigger runtime fetched", {
        triggerId: trigger.id,
        agentConfigId: runtime.agentConfigId,
        hasAuthPath: Boolean(runtime.authPath)
      });
      activeLogReporter.append("INFO", `Runtime fetched (agentConfigId=${runtime.agentConfigId}).`);

      let effectiveAuthPath = runtime.authPath;

      if (runtime.useWorktree && runtime.authPath) {
        try {
          if (isGitRepo(runtime.authPath)) {
            const worktreePath = createWorktree(runtime.authPath, {
              worktreeId: runtime.worktreeId ?? trigger.id,
              baseBranch: runtime.baseBranch
            });
            effectiveAuthPath = worktreePath;
            await client.reportWorktreeStatus(trigger.id, "ACTIVE");
            activeLogReporter.append("INFO", `Worktree created at ${worktreePath}.`);
            logger.info("Worktree created for trigger", {
              triggerId: trigger.id,
              worktreePath
            });
          } else {
            logger.warn("Worktree requested but authPath is not a git repo, falling back to authPath", {
              triggerId: trigger.id,
              authPath: runtime.authPath
            });
            activeLogReporter.append("WARN", "Worktree requested but authPath is not a git repo. Falling back to authPath.");
          }
        } catch (err) {
          logger.warn("Failed to create worktree, falling back to authPath", {
            triggerId: trigger.id,
            error: err instanceof Error ? err.message : String(err)
          });
          activeLogReporter.append("WARN", `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}. Falling back to authPath.`);
          try {
            await client.reportWorktreeStatus(trigger.id, "FAILED");
          } catch {
            // Ignore status report failure
          }
        }
      }

      const historyPaths = resolveHistoryPaths(effectiveAuthPath, trigger.id, trigger.parentTriggerId);
      currentHistoryPath = historyPaths.currentHistoryPath;
      await restoreParentHistoryFromServer(historyPaths.parentHistoryPath, runtime.parentHistoryMarkdown);
      if (effectiveAuthPath && runtime.attachments && runtime.attachments.length > 0) {
        attachmentDir = join(effectiveAuthPath, ".agentteams", "runner", "attachments", trigger.id);
      }
      const downloadedAttachments = await downloadRuntimeAttachments(runtime.attachments, effectiveAuthPath, trigger.id);
      if (downloadedAttachments.length > 0) {
        activeLogReporter.append("INFO", `Downloaded ${downloadedAttachments.length} attachment(s) for runner access.`);
      }
      const runnerPrompt = appendAttachmentSection(
        resolveRunnerPrompt(runtime.runnerPrompt, historyPaths.currentHistoryPath, historyPaths.parentHistoryPath),
        downloadedAttachments
      );

      const runner = createRunner(trigger.runnerType);
      const cancelController = new AbortController();
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
            activeLogReporter.append("WARN", "Cancellation requested by user. Stopping runner.");
            cancelController.abort();
          }
        } catch (error) {
          logger.warn("Failed to fetch trigger cancel status", {
            triggerId: trigger.id,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          cancelCheckInFlight = false;
        }
      };
      await checkCancelRequested();
      cancelInterval = setIntervalFn(() => {
        void checkCancelRequested();
      }, cancelPollIntervalMs);
      const runnerFastMode = (trigger.runnerType === "CODEX" || trigger.runnerType === "CLAUDE_CODE")
        ? trigger.fastMode
        : false;
      if (trigger.fastMode && !runnerFastMode) {
        logger.warn("Fast mode requested for unsupported runner; ignoring", {
          triggerId: trigger.id,
          runnerType: trigger.runnerType
        });
        activeLogReporter.append("WARN", `Fast mode is not supported for runner ${trigger.runnerType}; ignoring.`);
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
        idleTimeoutMs: config.idleTimeoutMs,
        agentConfigId: runtime.agentConfigId,
        model: trigger.model,
        fastMode: runnerFastMode,
        signal: cancelController.signal,
        onStdoutChunk: (chunk) => {
          activeLogReporter.append("INFO", chunk);
        },
        onStderrChunk: (chunk) => {
          activeLogReporter.append("WARN", chunk);
        }
      });
      clearIntervalFn(cancelInterval);
      cancelInterval = null;
      logger.info("Trigger runner finished", {
        triggerId: trigger.id,
        exitCode: runResult.exitCode
      });
      logReporter.append("INFO", `Runner finished with exitCode=${runResult.exitCode}.`);
      await reportHistory(trigger.id, currentHistoryPath, logReporter, {
        outputText: runResult.outputText ?? "",
        errorMessage: runResult.exitCode === 0 ? undefined : runResult.errorMessage
      });

      await logReporter.stop();

      // 3차 방어: origin issue 자동 연결 안전장치 (fire-and-forget)
      void runOriginIssueSafeguard(trigger.prompt, currentHistoryPath, effectiveAuthPath).catch(() => {
        // Safeguard failure should never block trigger completion
      });

      const status = runResult.cancelled
        ? "CANCELLED"
        : runResult.exitCode === 0 ? "DONE" : "FAILED";
      const errorMessage = status === "FAILED"
        ? (runResult.errorMessage || runResult.lastOutput || `Runner exited with code ${runResult.exitCode}`)
        : status === "CANCELLED"
          ? (runResult.errorMessage || "Runner cancelled by user")
        : undefined;
      await client.updateTriggerStatus(
        trigger.id,
        status,
        errorMessage ? sanitizeErrorMessage(errorMessage) : undefined
      );
      logger.info("Trigger completed", {
        triggerId: trigger.id,
        status
      });
    } catch (error) {
      if (cancelInterval) {
        clearIntervalFn(cancelInterval);
        cancelInterval = null;
      }
      logger.error("Trigger handling failed", {
        triggerId: trigger.id,
        error: error instanceof Error ? error.message : String(error)
      });

      try {
        logReporter?.append("ERROR", error instanceof Error ? error.message : String(error));
        await reportHistory(trigger.id, currentHistoryPath, logReporter);
        if (logReporter) {
          await logReporter.stop();
        }
        const rawErrorMsg = error instanceof Error ? error.message : String(error);
        await client.updateTriggerStatus(
          trigger.id,
          "FAILED",
          sanitizeErrorMessage(rawErrorMsg)
        );
      } catch (statusError) {
        logger.error("Failed to report trigger as FAILED", {
          triggerId: trigger.id,
          error: statusError instanceof Error ? statusError.message : String(statusError)
        });
      }
    } finally {
      if (attachmentDir) {
        try {
          await removeAttachmentDirectory(attachmentDir);
        } catch (cleanupError) {
          logger.warn("Failed to remove runner attachment directory", {
            triggerId: trigger.id,
            attachmentDir,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
    }
  };
};
