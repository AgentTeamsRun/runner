/**
 * Parses GitHub Copilot CLI `--output-format json` JSONL events.
 *
 * Copilot marks high-volume deltas, skill metadata, and opaque reasoning as `ephemeral`. Those
 * events are discarded before payload inspection so blobs and tool bodies cannot reach logs.
 */

import type { ParseOptions, ParsedLogEntry } from './stream-json-parser.js';
import { firstSentence, shortenPath } from './stream-json-parser.js';

const COMMAND_PREVIEW_MAX = 100;
const TOOL_PREVIEW_MAX = 120;

type CopilotData = {
  content?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
};

type CopilotUsage = {
  sessionDurationMs?: number;
  codeChanges?: { filesModified?: string[] };
};

type CopilotEvent = {
  type?: string;
  ephemeral?: boolean;
  data?: CopilotData;
  exitCode?: number;
  usage?: CopilotUsage;
};

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

const stringField = (input: Record<string, unknown> | undefined, key: string): string => {
  const value = input?.[key];
  return typeof value === 'string' ? value : '';
};

export const summarizeCopilotTool = (
  toolName: string,
  args: Record<string, unknown> | undefined,
  cwd?: string,
): string => {
  const path = stringField(args, 'path') || stringField(args, 'file_path') || stringField(args, 'filePath');
  if (path) {
    return `${toolName}: ${shortenPath(path, cwd)}`;
  }

  const rawCommand = stringField(args, 'command').trim().split(/\r?\n/)[0] ?? '';
  if (rawCommand) {
    const command = cwd && rawCommand.includes(cwd) ? rawCommand.split(cwd).join('.') : rawCommand;
    return `${toolName}: ${truncate(command, COMMAND_PREVIEW_MAX)}`;
  }

  const keys = Object.keys(args ?? {})
    .slice(0, 3)
    .join(',');
  return keys ? `${toolName}(${keys})` : toolName;
};

export const parseCopilotJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: CopilotEvent;
  try {
    parsed = JSON.parse(trimmed) as CopilotEvent;
  } catch {
    return [];
  }

  if (parsed.ephemeral === true) {
    return [];
  }

  switch (parsed.type) {
    case 'assistant.message': {
      const content = parsed.data?.content;
      return typeof content === 'string' && content.trim().length > 0
        ? [{ level: 'INFO', message: firstSentence(content) }]
        : [];
    }

    case 'assistant.reasoning': {
      const content = parsed.data?.content;
      const verbose = options?.verbose ?? process.env.AGENTTEAMS_RUNNER_VERBOSE === '1';
      return verbose && typeof content === 'string' && content.trim().length > 0
        ? [{ level: 'INFO', message: `[Thinking] ${truncate(content.trim(), 300)}` }]
        : [];
    }

    case 'tool.execution_start': {
      const toolName = parsed.data?.toolName ?? 'unknown';
      const summary = truncate(summarizeCopilotTool(toolName, parsed.data?.arguments, options?.cwd), TOOL_PREVIEW_MAX);
      return [{ level: 'INFO', message: `[Tool] ${summary}` }];
    }

    case 'tool.execution_complete': {
      if (parsed.data?.success !== false) {
        return [];
      }
      const toolName = parsed.data.toolName ?? 'unknown';
      return [{ level: 'WARN', message: `[Tool] ${toolName} (failed)` }];
    }

    case 'result': {
      const durationMs = parsed.usage?.sessionDurationMs;
      const duration = typeof durationMs === 'number' ? ` in ${Math.round(durationMs / 1000)}s` : '';
      const files = parsed.usage?.codeChanges?.filesModified;
      const changed = Array.isArray(files) && files.length > 0 ? `, ${files.length} file(s) changed` : '';
      const failed = typeof parsed.exitCode === 'number' && parsed.exitCode !== 0;
      return [
        {
          level: failed ? 'WARN' : 'INFO',
          message: `[Result] ${failed ? 'Failed' : 'Completed'}${duration}${changed}`,
        },
      ];
    }

    default:
      return [];
  }
};

export const createCopilotJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } => {
  let buffer = '';

  const scan = (line: string): void => {
    const entries = parseCopilotJsonLine(line, options);
    if (entries.length > 0) {
      onEntries(entries);
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        scan(line);
      }
    },
    flush() {
      if (buffer.trim().length > 0) {
        scan(buffer);
      }
      buffer = '';
    },
  };
};

const assistantText = (line: string): string | null => {
  let parsed: CopilotEvent;
  try {
    parsed = JSON.parse(line.trim()) as CopilotEvent;
  } catch {
    return null;
  }

  const content = parsed.data?.content;
  return parsed.ephemeral !== true &&
    parsed.type === 'assistant.message' &&
    typeof content === 'string' &&
    content.trim().length > 0
    ? content.trim()
    : null;
};

export const createCopilotFinalTextCapturer = (): {
  push: (chunk: string) => void;
  flush: () => void;
  get: () => string | null;
} => {
  let buffer = '';
  let finalText: string | null = null;

  const scan = (line: string): void => {
    finalText = assistantText(line) ?? finalText;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        scan(line);
      }
    },
    flush() {
      if (buffer.trim().length > 0) {
        scan(buffer);
      }
      buffer = '';
    },
    get: () => finalText,
  };
};
