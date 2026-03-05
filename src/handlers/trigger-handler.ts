import type { DaemonTrigger, RuntimeConfig } from "../types.js";
import { DaemonApiClient } from "../api-client.js";
import { createRunnerFactory } from "../runners/index.js";
import { TriggerLogReporter } from "../runners/log-reporter.js";
import { logger } from "../logger.js";
import { extractCoActionId } from "../utils/coaction-id.js";

export const createTriggerHandler = (
  config: RuntimeConfig,
  client: DaemonApiClient
) => {
  const createRunner = createRunnerFactory(config.runnerCmd);
  const coActionInstruction = (coActionId: string | null): string => {
    if (coActionId) {
      return [
        "",
        "----",
        "CoAction update rule (required):",
        `- Update the existing CoAction only: ${coActionId}`,
        "- Do NOT create a new CoAction.",
        `- Output this exact marker at the end: COACTION_ID: ${coActionId}`,
        "----"
      ].join("\n");
    }

    return [
      "",
      "----",
      "CoAction update rule (required):",
      "- Reuse an existing CoAction if one is already available for this work context.",
      "- Create a new CoAction only if no existing CoAction can be reused.",
      "- Output this exact marker at the end with the final CoAction id: COACTION_ID: <uuid>",
      "----"
    ].join("\n");
  };

  const toPromptString = (prompt: DaemonTrigger["prompt"]): string => {
    if (typeof prompt === "string") {
      return prompt;
    }

    return JSON.stringify(prompt);
  };

  const buildRunnerPrompt = (trigger: DaemonTrigger): string => {
    const basePrompt = toPromptString(trigger.prompt);
    return `${basePrompt}${coActionInstruction(trigger.coActionId)}`;
  };

  return async (trigger: DaemonTrigger): Promise<void> => {
    let logReporter: TriggerLogReporter | null = null;
    let detectedCoActionId: string | null = null;

    const captureCoActionId = (chunk: string): void => {
      if (detectedCoActionId) {
        return;
      }

      const parsed = extractCoActionId(chunk);
      if (!parsed) {
        return;
      }

      detectedCoActionId = parsed;
      logger.info("Co-action id detected from runner output", {
        triggerId: trigger.id,
        coActionId: parsed
      });
      logReporter?.append("INFO", `Detected COACTION_ID=${parsed}`);
    };

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

      const runner = createRunner(trigger.runnerType);
      const runResult = await runner.run({
        triggerId: trigger.id,
        prompt: buildRunnerPrompt(trigger),
        authPath: runtime.authPath,
        apiKey: runtime.apiKey,
        apiUrl: config.apiUrl,
        timeoutMs: config.timeoutMs,
        agentConfigId: runtime.agentConfigId,
        onStdoutChunk: (chunk) => {
          captureCoActionId(chunk);
          logReporter?.append("INFO", chunk);
        },
        onStderrChunk: (chunk) => {
          captureCoActionId(chunk);
          logReporter?.append("WARN", chunk);
        }
      });
      logger.info("Trigger runner finished", {
        triggerId: trigger.id,
        exitCode: runResult.exitCode
      });
      logReporter.append("INFO", `Runner finished with exitCode=${runResult.exitCode}.`);
      await logReporter.stop();

      const status = runResult.exitCode === 0 ? "DONE" : "FAILED";
      const errorMessage = status === "FAILED"
        ? (runResult.errorMessage || runResult.lastOutput || `Runner exited with code ${runResult.exitCode}`)
        : undefined;
      await client.updateTriggerStatus(
        trigger.id,
        status,
        errorMessage,
        detectedCoActionId ?? undefined
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
        if (logReporter) {
          await logReporter.stop();
        }
        await client.updateTriggerStatus(
          trigger.id,
          "FAILED",
          error instanceof Error ? error.message : String(error),
          detectedCoActionId ?? undefined
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
