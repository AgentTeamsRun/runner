import type { ConventionMeta, DaemonTrigger, RuntimeConfig } from "../types.js";
import { DaemonApiClient } from "../api-client.js";
import { createRunnerFactory } from "../runners/index.js";
import { TriggerLogReporter } from "../runners/log-reporter.js";
import { logger } from "../logger.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { resolveRunnerHistoryPaths } from "../utils/runner-history.js";
import { isGitRepo, createWorktree } from "../utils/git-worktree.js";
import { extractResultTextFromStreamJson } from "../runners/claude-code.js";
import { runOriginIssueSafeguard } from "../utils/origin-issue-safeguard.js";
import { evaluateConventionTriggers } from "../utils/convention-evaluator.js";
import type { HookDefinition } from "../harness/types.js";
import { createEmptyHarnessConfig, loadHarnessConfigById } from "../harness/config-loader.js";
import { executePreHooks } from "../harness/hook-executor.js";
import type { HookContext } from "../harness/hook-executor.js";
import type { HarnessConfig } from "../harness/types.js";

function sanitizeErrorMessage(msg: string): string {
  return msg.replaceAll(homedir(), '~');
}

function filterHooksByConventionMatch(
  hooks: HookDefinition[],
  matchedConventions: ConventionMeta[]
): HookDefinition[] {
  const matchedIds = new Set(matchedConventions.map((c) => c.id));
  const matchedTriggers = new Set(
    matchedConventions.map((c) => c.trigger).filter(Boolean) as string[]
  );

  return hooks.filter((hook) => {
    // conventionId takes priority (new stable link)
    if (hook.conventionId) return matchedIds.has(hook.conventionId);
    // Legacy: conventionTrigger string match (deprecated)
    if (hook.conventionTrigger) return matchedTriggers.has(hook.conventionTrigger);
    // Unconditional hook → always runs
    return true;
  });
}

type TriggerHandlerOptions = {
  config: RuntimeConfig;
  client: DaemonApiClient;
  onAuthPathDiscovered?: (authPath: string) => void;
};

type ReporterLike = Pick<TriggerLogReporter, "start" | "append" | "stop">;
type ReadHistoryFile = (path: string, encoding: BufferEncoding) => Promise<string>;
type WriteHistoryFile = (path: string, content: string) => Promise<void>;

type TriggerHandlerDependencies = {
  createRunnerFactory?: typeof createRunnerFactory;
  createLogReporter?: (client: DaemonApiClient, triggerId: string) => ReporterLike;
  readHistoryFile?: ReadHistoryFile;
  writeHistoryFile?: WriteHistoryFile;
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
  const resolveHistoryPaths = dependencies.resolveRunnerHistoryPaths ?? resolveRunnerHistoryPaths;
  const maxHistoryLength = 200000;
  const setIntervalFn = dependencies.setIntervalFn ?? global.setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn ?? global.clearInterval;
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? 2000;
  const stripUtf8Bom = (content: string): string => content.replace(/^\uFEFF/, "");
  const currentHistoryPathPlaceholder = "{{AGENTRUNNER_CURRENT_HISTORY_PATH}}";
  const parentHistoryPathPlaceholder = "{{AGENTRUNNER_PARENT_HISTORY_PATH}}";

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

    const maxOutputLength = 1500;
    const truncated = trimmed.length > maxOutputLength
      ? trimmed.slice(0, maxOutputLength) + "\n- *(truncated)*"
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
      const runnerPrompt = resolveRunnerPrompt(runtime.runnerPrompt, historyPaths.currentHistoryPath, historyPaths.parentHistoryPath);

      let matchedConventions: ConventionMeta[] = [];
      if (effectiveAuthPath && runtime.conventions && runtime.conventions.length > 0) {
        matchedConventions = evaluateConventionTriggers(runtime.conventions, {
          authPath: effectiveAuthPath,
          planType: runtime.planType ?? null,
        });
      }

      // -- Load selected server harness config & append pinned conventions ------
      let harnessConfig: HarnessConfig = createEmptyHarnessConfig();

      if (effectiveAuthPath && runtime.harnessConfigId) {
        harnessConfig = await loadHarnessConfigById(client, runtime.harnessConfigId);

        // Append harness-pinned conventions that aren't already matched
        if (harnessConfig.conventionIds.length > 0 && runtime.conventions) {
          const alreadyMatchedIds = new Set(matchedConventions.map((c) => c.id));
          const pinnedConventions = runtime.conventions.filter(
            (c) => harnessConfig.conventionIds.includes(c.id) && !alreadyMatchedIds.has(c.id)
          );
          if (pinnedConventions.length > 0) {
            matchedConventions = [...matchedConventions, ...pinnedConventions];
          }
        }
      }

      // -- Pre-execution hooks --------------------------------------------------
      if (effectiveAuthPath) {
        const filteredPreHooks = filterHooksByConventionMatch(harnessConfig.preHooks, matchedConventions);

        if (filteredPreHooks.length > 0) {
          activeLogReporter.append("INFO", `Running ${filteredPreHooks.length} pre-execution hook(s).`);

          const hookContext: HookContext = {
            authPath: effectiveAuthPath,
            triggerId: trigger.id,
            triggerLogAppend: (level, msg) => activeLogReporter.append(level, msg),
          };

          const hookOutcome = await executePreHooks(filteredPreHooks, hookContext);

          if (hookOutcome.failureAction === "fail" || hookOutcome.failureAction === "needs_review") {
            const errorMessage = hookOutcome.failureReason ?? "Pre-execution hook failed.";
            const failStatus = hookOutcome.failureAction === "needs_review" ? "NEEDS_REVIEW" as const : "FAILED" as const;
            logger.warn("Pre-execution hook blocked trigger", {
              triggerId: trigger.id,
              reason: errorMessage,
            });
            activeLogReporter.append("ERROR", `Trigger blocked by pre-hook: ${errorMessage}`);
            await logReporter.stop();
            await client.updateTriggerStatus(trigger.id, failStatus, errorMessage);
            return;
          }

          activeLogReporter.append("INFO", "All pre-execution hooks passed.");
        }
      }
      // -- End pre-execution hooks ----------------------------------------------

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

      // -- Post-execution hooks -------------------------------------------------
      let postHookStatus: "DONE" | "FAILED" | "NEEDS_REVIEW" | null = null;
      let postHookError: string | undefined;

      const filteredPostHooks = filterHooksByConventionMatch(harnessConfig.postHooks, matchedConventions);

      if (!runResult.cancelled && runResult.exitCode === 0 && effectiveAuthPath && filteredPostHooks.length > 0) {
        activeLogReporter.append("INFO", `Running ${filteredPostHooks.length} post-execution hook(s).`);

        const postHookContext: HookContext = {
          authPath: effectiveAuthPath,
          triggerId: trigger.id,
          triggerLogAppend: (level, msg) => activeLogReporter.append(level, msg),
        };

        const postOutcome = await executePreHooks(filteredPostHooks, postHookContext);

        if (postOutcome.failureAction === "fail") {
          postHookStatus = "FAILED";
          postHookError = postOutcome.failureReason ?? "Post-execution hook failed.";
          activeLogReporter.append("ERROR", `Post-hook blocked: ${postHookError}`);
        } else if (postOutcome.failureAction === "needs_review") {
          postHookStatus = "NEEDS_REVIEW";
          postHookError = postOutcome.failureReason ?? "Post-execution hook requires review.";
          activeLogReporter.append("WARN", `Post-hook requires review: ${postHookError}`);
        } else {
          activeLogReporter.append("INFO", "All post-execution hooks passed.");
        }
      }
      // -- End post-execution hooks ---------------------------------------------

      await logReporter.stop();

      // 3차 방어: origin issue 자동 연결 안전장치 (fire-and-forget)
      void runOriginIssueSafeguard(trigger.prompt, currentHistoryPath, effectiveAuthPath).catch(() => {
        // Safeguard failure should never block trigger completion
      });

      const status = runResult.cancelled
        ? "CANCELLED"
        : postHookStatus
          ? postHookStatus
          : runResult.exitCode === 0 ? "DONE" : "FAILED";
      const errorMessage = status === "FAILED"
        ? (postHookError || runResult.errorMessage || runResult.lastOutput || `Runner exited with code ${runResult.exitCode}`)
        : status === "CANCELLED"
          ? (runResult.errorMessage || "Runner cancelled by user")
        : status === "NEEDS_REVIEW"
          ? postHookError
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
    }
  };
};
