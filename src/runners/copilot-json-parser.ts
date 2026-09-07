/**
 * Parses GitHub Copilot CLI `--output-format json` JSONL events.
 *
 * Copilot marks high-volume deltas, skill metadata, and opaque reasoning as `ephemeral`. Those
 * events are discarded before payload inspection so blobs and tool bodies cannot reach logs.
 */

import { createJsonLineBuffer } from './json-line-buffer.js';
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

const decodeCopilotEvent = (line: string): CopilotEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as CopilotEvent;
  } catch {
    return null;
  }
};

const parseCopilotEvent = (parsed: CopilotEvent, options?: ParseOptions): ParsedLogEntry[] => {
  if (parsed.ephemeral === true) {
    return [];
  }

  switch (parsed.type) {
    case 'assistant.message': {
      const content = parsed.data?.content;
      return typeof content === 'string' && content.trim().length > 0
        ? [{ level: 'INFO', category: 'TEXT', message: firstSentence(content) }]
        : [];
    }

    case 'assistant.reasoning': {
      const content = parsed.data?.content;
      const verbose = options?.verbose ?? process.env.AGENTTEAMS_RUNNER_VERBOSE === '1';
      return verbose && typeof content === 'string' && content.trim().length > 0
        ? [{ level: 'INFO', category: 'THINKING', message: `[Thinking] ${truncate(content.trim(), 300)}` }]
        : [];
    }

    case 'tool.execution_start': {
      const toolName = parsed.data?.toolName ?? 'unknown';
      const summary = truncate(summarizeCopilotTool(toolName, parsed.data?.arguments, options?.cwd), TOOL_PREVIEW_MAX);
      return [{ level: 'INFO', category: 'TOOL', toolName, message: `[Tool] ${summary}` }];
    }

    case 'tool.execution_complete': {
      if (parsed.data?.success !== false) {
        return [];
      }
      const toolName = parsed.data.toolName ?? 'unknown';
      return [{ level: 'WARN', category: 'TOOL', toolName, message: `[Tool] ${toolName} (failed)` }];
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
          category: 'RESULT',
          message: `[Result] ${failed ? 'Failed' : 'Completed'}${duration}${changed}`,
        },
      ];
    }

    default:
      return [];
  }
};

export const parseCopilotJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const parsed = decodeCopilotEvent(line);
  return parsed ? parseCopilotEvent(parsed, options) : [];
};

// 한 줄을 한 번만 디코드해 로그 정제와 사용량 수집에 팬아웃한다.
// stdout 원문을 수집기 push에 직접 넣으면 라인당 JSON.parse가 두 번 돌므로,
// codex 선례대로 파서 계약 확장 방식을 쓴다.
export const createCopilotJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } =>
  createJsonLineBuffer((line) => {
    const parsed = decodeCopilotEvent(line);
    if (parsed) {
      options?.onEvent?.(parsed);
      const entries = parseCopilotEvent(parsed, options);
      if (entries.length > 0) {
        onEntries(entries);
      }
    }
  }, options?.onDropped);

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
