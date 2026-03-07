import type { DaemonTrigger, RuntimeConfig } from "../types.js";
import { DaemonApiClient } from "../api-client.js";
import { createRunnerFactory } from "../runners/index.js";
import { TriggerLogReporter } from "../runners/log-reporter.js";
import { logger } from "../logger.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveRunnerHistoryPaths } from "../utils/runner-history.js";

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

  const reportHistoryToDatabase = async (
    triggerId: string,
    historyPath: string | null
  ): Promise<boolean> => {
    if (!historyPath) {
      return false;
    }

    try {
      const content = await readHistoryFile(historyPath, "utf8");
      const markdown = content.trim();
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

  const buildFallbackHistory = (outputText: string): string => {
    const output = outputText.trim().slice(0, maxHistoryLength);
    return [
      "### Summary",
      "- Runner completed successfully but did not write the requested history file.",
      "- Stored captured stdout as fallback history for this run.",
      "",
      "### Output",
      output
    ].join("\n");
  };

  const restoreParentHistoryFromServer = async (
    parentHistoryPath: string | null,
    parentHistoryMarkdown: string | null
  ): Promise<void> => {
    const normalizedMarkdown = parentHistoryMarkdown?.trim() ?? "";

    if (!parentHistoryPath || normalizedMarkdown.length === 0) {
      return;
    }

    await writeHistoryFile(parentHistoryPath, normalizedMarkdown.slice(0, maxHistoryLength));
  };

  const toPromptString = (prompt: DaemonTrigger["prompt"]): string => {
    if (typeof prompt === "string") {
      return prompt;
    }

    return JSON.stringify(prompt);
  };

  const buildRunnerPrompt = (trigger: DaemonTrigger, currentHistoryPath: string | null, parentHistoryPath: string | null): string => {
    const basePrompt = toPromptString(trigger.prompt);
    const isContinuation = Boolean(trigger.parentTriggerId);

    const historyLines = [
      "",
      "----",
      isContinuation ? "Continuation context (required):" : "History context (required):",
      ...(isContinuation
        ? [
            `- parentTriggerId: ${trigger.parentTriggerId}`,
            `- Previous history path: ${parentHistoryPath ?? "(unavailable: authPath not configured)"}`,
            "- Read the previous history file first and continue without repeating completed work.",
            "- If the previous history has a Suggestions for User section, consider those suggestions in the context of the user's current prompt and proceed accordingly.",
          ]
        : []),
      `- History path: ${currentHistoryPath ?? "(unavailable: authPath not configured)"}`,
      "- Save history as a Markdown file (.md) at the history path.",
      "- Overwrite the markdown file with the latest full summary for this run.",
      "- Format rules:",
      "  - Do not add a top-level title (e.g., # Runner History).",
      "  - Use ### (h3) headings to organize sections.",
      "  - Add whatever sections best describe the work (e.g., ### Changes, ### Verification, ### Next Steps).",
      "  - Required section: ### Summary — 3-5 bullet points of what was done. This is used for handoff to the next session.",
      "  - Required section: ### Questions for User — include only blocking or decision-required questions (up to 3). Write 'None' if there are no questions.",
      "----"
    ];

    return `${basePrompt}\n${historyLines.join("\n")}`;
  };

  return async (trigger: DaemonTrigger): Promise<void> => {
    let logReporter: ReporterLike | null = null;
    let currentHistoryPath: string | null = null;
    let cancelInterval: NodeJS.Timeout | null = null;

    try {
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

      const historyPaths = resolveHistoryPaths(runtime.authPath, trigger.id, trigger.parentTriggerId);
      currentHistoryPath = historyPaths.currentHistoryPath;
      await restoreParentHistoryFromServer(historyPaths.parentHistoryPath, runtime.parentHistoryMarkdown);
      const runnerPrompt = buildRunnerPrompt(trigger, historyPaths.currentHistoryPath, historyPaths.parentHistoryPath);

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
        authPath: runtime.authPath,
        apiKey: runtime.apiKey,
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
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
      if (!historyReported && runResult.exitCode === 0 && runResult.outputText) {
        const fallbackHistory = buildFallbackHistory(runResult.outputText);
        if (currentHistoryPath) {
          await writeHistoryFile(currentHistoryPath, fallbackHistory);
        }
        await client.updateTriggerHistory(trigger.id, fallbackHistory);
        logReporter.append("WARN", "Runner did not write a history file. Captured stdout was stored as fallback history.");
      }
      await logReporter.stop();

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
        errorMessage
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
        await client.updateTriggerStatus(
          trigger.id,
          "FAILED",
          error instanceof Error ? error.message : String(error)
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
