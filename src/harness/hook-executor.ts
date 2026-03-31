import { spawn } from "node:child_process";
import type { HookDefinition, HookFailureAction } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookLogLevel = "INFO" | "WARN" | "ERROR";

export type HookContext = {
  authPath: string;
  triggerId: string;
  triggerLogAppend: (level: HookLogLevel, message: string) => void;
};

export type HookResult = {
  name: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type PreHooksOutcome = {
  results: HookResult[];
  /** If a hook failed with a blocking policy, this is set. */
  failureAction: HookFailureAction | null;
  /** Human-readable reason for the failure. */
  failureReason: string | null;
};

// ---------------------------------------------------------------------------
// Single hook execution
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

export const executeHook = (
  hook: HookDefinition,
  context: HookContext,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<HookResult> => {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(hook.command, {
      cwd: context.authPath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        name: hook.name,
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      settle(code);
    });

    child.on("error", (err) => {
      stderr += err.message;
      settle(1);
    });

    // Timeout handling
    killTimer = setTimeout(() => {
      if (!settled) {
        stderr += `\nHook timed out after ${timeoutMs}ms`;
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
        settle(null);
      }
    }, timeoutMs);
  });
};

// ---------------------------------------------------------------------------
// Sequential pre-hook execution
// ---------------------------------------------------------------------------

export const executePreHooks = async (
  hooks: HookDefinition[],
  context: HookContext
): Promise<PreHooksOutcome> => {
  const results: HookResult[] = [];

  if (hooks.length === 0) {
    return { results, failureAction: null, failureReason: null };
  }

  for (const hook of hooks) {
    context.triggerLogAppend("INFO", `Running pre-hook: ${hook.name} (${hook.command})`);

    const result = await executeHook(hook, context);
    results.push(result);

    context.triggerLogAppend(
      result.success ? "INFO" : "WARN",
      `Pre-hook "${hook.name}" ${result.success ? "passed" : "failed"} (exit=${result.exitCode}, ${result.durationMs}ms)`
    );

    if (result.stdout.trim()) {
      context.triggerLogAppend("INFO", `[${hook.name} stdout] ${result.stdout.trim()}`);
    }
    if (result.stderr.trim()) {
      context.triggerLogAppend("WARN", `[${hook.name} stderr] ${result.stderr.trim()}`);
    }

    if (!result.success) {
      if (hook.onFailure === "warn") {
        context.triggerLogAppend("WARN", `Pre-hook "${hook.name}" failed but onFailure=warn, continuing.`);
        continue;
      }

      // "fail" or "needs_review" — both block execution
      const reason = `Pre-hook "${hook.name}" failed with exit code ${result.exitCode}. Policy: ${hook.onFailure}.`;
      context.triggerLogAppend("ERROR", reason);

      return {
        results,
        failureAction: hook.onFailure,
        failureReason: reason,
      };
    }
  }

  return { results, failureAction: null, failureReason: null };
};
