import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { logger } from "../logger.js";
import type { ConventionMeta } from "../types.js";

type EvaluationContext = {
  authPath: string;
  planType: string | null;
};

type ParsedCondition =
  | { type: "file"; patterns: string[] }
  | { type: "task"; taskTypes: string[] }
  | { type: "composite"; filePatterns: string[]; taskTypes: string[] };

const parseConditionalTrigger = (trigger: string): ParsedCondition | null => {
  const parts = trigger.split("|").map((p) => p.trim()).filter(Boolean);
  const filePatterns: string[] = [];
  const taskTypes: string[] = [];

  for (const part of parts) {
    if (part.startsWith("file:")) {
      const pattern = part.slice(5).trim();
      if (pattern.length > 0) filePatterns.push(pattern);
    } else if (part.startsWith("task:")) {
      const taskType = part.slice(5).trim().toUpperCase();
      if (taskType.length > 0) taskTypes.push(taskType);
    }
  }

  if (filePatterns.length > 0 && taskTypes.length > 0) {
    return { type: "composite", filePatterns, taskTypes };
  }
  if (filePatterns.length > 0) return { type: "file", patterns: filePatterns };
  if (taskTypes.length > 0) return { type: "task", taskTypes };
  return null;
};

const getChangedFiles = (authPath: string): string[] => {
  try {
    const output = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: authPath,
      encoding: "utf8",
      timeout: 10_000,
    });

    const statusOutput = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: authPath,
      encoding: "utf8",
      timeout: 10_000,
    });

    const files = [...output.split("\n"), ...statusOutput.split("\n")]
      .map((f) => f.trim())
      .filter(Boolean);

    return Array.from(new Set(files));
  } catch (error) {
    logger.warn("Failed to get changed files for convention evaluation", {
      authPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

const matchesFilePatterns = (changedFiles: string[], patterns: string[]): boolean => {
  return changedFiles.some((file) =>
    patterns.some((pattern) => {
      try {
        return matchesGlob(file, pattern);
      } catch {
        return false;
      }
    })
  );
};

const matchesTaskType = (planType: string | null, taskTypes: string[]): boolean => {
  if (!planType) return false;
  return taskTypes.includes(planType.toUpperCase());
};

export const evaluateConventionTriggers = (
  conventions: ConventionMeta[],
  context: EvaluationContext
): ConventionMeta[] => {
  if (conventions.length === 0) return [];

  let changedFiles: string[] | null = null;

  const matched: ConventionMeta[] = [];

  for (const convention of conventions) {
    if (!convention.trigger) continue;

    const condition = parseConditionalTrigger(convention.trigger);
    if (!condition) continue;

    switch (condition.type) {
      case "file": {
        if (changedFiles === null) changedFiles = getChangedFiles(context.authPath);
        if (matchesFilePatterns(changedFiles, condition.patterns)) {
          matched.push(convention);
        }
        break;
      }
      case "task": {
        if (matchesTaskType(context.planType, condition.taskTypes)) {
          matched.push(convention);
        }
        break;
      }
      case "composite": {
        if (changedFiles === null) changedFiles = getChangedFiles(context.authPath);
        if (
          matchesFilePatterns(changedFiles, condition.filePatterns) ||
          matchesTaskType(context.planType, condition.taskTypes)
        ) {
          matched.push(convention);
        }
        break;
      }
    }
  }

  if (matched.length > 0) {
    logger.info("Convention triggers matched", {
      matched: matched.map((c) => c.title),
    });
  }

  return matched;
};
