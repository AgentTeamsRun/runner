import type { DaemonTrigger, RuntimeConfig } from "../types.js";
import { DaemonApiClient } from "../api-client.js";
import { createRunnerFactory } from "../runners/index.js";
import { TriggerLogReporter } from "../runners/log-reporter.js";
import { logger } from "../logger.js";
import { readFile } from "node:fs/promises";
import { resolveRunnerHistoryPaths } from "../utils/runner-history.js";

export const createTriggerHandler = (
  config: RuntimeConfig,
  client: DaemonApiClient
) => {
  const createRunner = createRunnerFactory(config.runnerCmd);
  const maxHistoryLength = 200000;

  const reportHistoryToDatabase = async (
    triggerId: string,
    historyPath: string | null
  ): Promise<void> => {
    if (!historyPath) {
      return;
    }

    try {
      const content = await readFile(historyPath, "utf8");
      const markdown = content.trim();
      if (markdown.length === 0) {
        return;
      }
      await client.updateTriggerHistory(triggerId, markdown.slice(0, maxHistoryLength));
    } catch (error) {
      logger.warn("Failed to load or update runner history", {
        triggerId,
        historyPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const toPromptString = (prompt: DaemonTrigger["prompt"]): string => {
    if (typeof prompt === "string") {
      return prompt;
    }

    return JSON.stringify(prompt);
  };

  const buildRunnerPrompt = (trigger: DaemonTrigger, currentHistoryPath: string | null, parentHistoryPath: string | null): string => {
    const basePrompt = toPromptString(trigger.prompt);
    if (!trigger.parentTriggerId) {
      return basePrompt;
    }

    const continuationLines = [
      "",
      "----",
      "Continuation context (required):",
      `- parentTriggerId: ${trigger.parentTriggerId}`,
      `- Previous history path: ${parentHistoryPath ?? "(unavailable: authPath not configured)"}`,
      `- Current history path: ${currentHistoryPath ?? "(unavailable: authPath not configured)"}`,
      "- Read the previous history file first and continue without repeating completed work.",
      "- Save history as a Markdown file (.md) at the current history path.",
      "- Overwrite the markdown file with the latest full summary for this run.",
      "- Required sections in the file:",
      "  1) ### Summary",
      "  2) ### Changes",
      "  3) ### Verification",
      "  4) ### Next Steps",
      "  5) ### Questions for User",
      "- Do not add a top-level title (e.g., # Runner History). Start directly with ## Summary.",
      "- In ### Summary, write 3-5 bullet points of what was done.",
      "- In ### Changes, include changed files (absolute or workspace-relative paths) and why.",
      "- In ### Verification, include executed commands and pass/fail results.",
      "- In ### Next Steps, include up to 3 concrete follow-up actions.",
      "- In ### Questions for User, include only blocking or decision-required questions (up to 3).",
      "- Do not truncate or abbreviate the ## Summary content in history.",
      "----"
    ];

    return `${basePrompt}\n${continuationLines.join("\n")}`;
  };

  return async (trigger: DaemonTrigger): Promise<void> => {
    let logReporter: TriggerLogReporter | null = null;
    let currentHistoryPath: string | null = null;

    try {
      logger.info("Trigger execution started", {
        triggerId: trigger.id,
        runnerType: trigger.runnerType
      });

      const runtime = await client.fetchTriggerRuntime(trigger.id);
      logReporter = new TriggerLogReporter(client, trigger.id);
      logReporter.start();
      logReporter.append("INFO", `Trigger started with runner ${trigger.runnerType}.`);

      logger.info("Trigger runtime fetched", {
        triggerId: trigger.id,
        agentConfigId: runtime.agentConfigId,
        hasAuthPath: Boolean(runtime.authPath)
      });
      logReporter.append("INFO", `Runtime fetched (agentConfigId=${runtime.agentConfigId}).`);

      const historyPaths = resolveRunnerHistoryPaths(runtime.authPath, trigger.id, trigger.parentTriggerId);
      currentHistoryPath = historyPaths.currentHistoryPath;
      const runnerPrompt = buildRunnerPrompt(trigger, historyPaths.currentHistoryPath, historyPaths.parentHistoryPath);

      const runner = createRunner(trigger.runnerType);
      const runResult = await runner.run({
        triggerId: trigger.id,
        prompt: runnerPrompt,
        authPath: runtime.authPath,
        apiKey: runtime.apiKey,
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
        agentConfigId: runtime.agentConfigId,
        onStdoutChunk: (chunk) => {
          logReporter?.append("INFO", chunk);
        },
        onStderrChunk: (chunk) => {
          logReporter?.append("WARN", chunk);
        }
      });
      logger.info("Trigger runner finished", {
        triggerId: trigger.id,
        exitCode: runResult.exitCode
      });
      logReporter.append("INFO", `Runner finished with exitCode=${runResult.exitCode}.`);
      await reportHistoryToDatabase(trigger.id, currentHistoryPath);
      await logReporter.stop();

      const status = runResult.exitCode === 0 ? "DONE" : "FAILED";
      const errorMessage = status === "FAILED"
        ? (runResult.errorMessage || runResult.lastOutput || `Runner exited with code ${runResult.exitCode}`)
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
