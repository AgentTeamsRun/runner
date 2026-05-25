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

  const reportHistoryToDatabase = async (
    triggerId: string,
    historyPath: string | null
  ): Promise<boolean> => {
    if (!historyPath) {
      return false;
    }

    try {
      const content = await readHistoryFile(historyPath, "utf8");
      const markdown = stripUtf8Bom(content).trim();
      if (markdown.length === 0) {
        return false;
      }
      await client.updateTriggerHistory(triggerId, markdown.slice(0, maxHistoryLength));
      return true;
    } catch (error) {
      logger.warn("Failed to load or update runner history", {
        triggerId,
        historyPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
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
      const historyReported = await reportHistoryToDatabase(trigger.id, currentHistoryPath);
      if (!historyReported && runResult.outputText) {
        const parsedOutput = extractResultTextFromStreamJson(runResult.outputText);
        const fallbackHistory = buildFallbackHistory(parsedOutput, runResult.exitCode === 0 ? undefined : runResult.errorMessage);
        if (currentHistoryPath) {
          await writeHistoryFile(currentHistoryPath, fallbackHistory);
        }
        await client.updateTriggerHistory(trigger.id, fallbackHistory);
        logReporter.append("WARN", "Runner did not write a history file. Captured stdout was stored as fallback history.");
      }

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
        await reportHistoryToDatabase(trigger.id, currentHistoryPath);
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
