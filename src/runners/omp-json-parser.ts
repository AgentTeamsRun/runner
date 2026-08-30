/**
 * Parses Oh My Pi `--mode json` NDJSON into human-readable log entries, the final assistant text,
 * and the stream-level failure cause. Measured against omp/18.0.6 on 2026-08-29 (macOS arm64);
 * `fixtures/omp-events.jsonl` and `fixtures/omp-events-error.jsonl` are verbatim captures.
 *
 * The stream carries two nesting levels and both must be handled:
 * - top-level lines: `session`, `notice`, `agent_start`, `turn_start`, `message_start`,
 *   `message_update`, `message_end`, `turn_end`, `tool_execution_start|update|end`, `agent_end`
 * - `message_update.assistantMessageEvent.type`: `thinking_*`, `text_*`, `toolcall_*`
 *
 * Mirrors opencode-json-parser.ts (parse / line-buffered parser / result capturer) so omp runs are
 * refined the same way instead of dumping raw NDJSON into the trigger log.
 */

import type { ParseOptions, ParsedLogEntry } from './stream-json-parser.js';
import { firstSentence, shortenPath } from './stream-json-parser.js';

const THINKING_PREVIEW_MAX = 300;
const TOOL_PREVIEW_MAX = 120;
const COMMAND_PREVIEW_MAX = 100;
const PATTERN_PREVIEW_MAX = 60;
const FAILURE_MESSAGE_MAX = 600;
const STREAMED_TEXT_FALLBACK_MAX = 200_000;

const COMMAND_ARG_KEYS = ['command', 'cmd', 'script'] as const;
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath'] as const;
const PATTERN_ARG_KEYS = ['pattern', 'query'] as const;

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

type OmpContentPart = { type?: string; text?: string };

type OmpMessage = {
  role?: string;
  content?: OmpContentPart[];
  stopReason?: string;
  errorStatus?: number;
  errorMessage?: string;
};

type OmpAssistantMessageEvent = {
  type?: string;
  content?: string;
  delta?: string;
};

type OmpEvent = {
  type?: string;
  message?: OmpMessage;
  assistantMessageEvent?: OmpAssistantMessageEvent;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  result?: { isError?: boolean };
};

const firstStringArg = (args: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
};

export const summarizeOmpTool = (toolName: string, args: Record<string, unknown> | undefined, cwd?: string): string => {
  const safeArgs = args ?? {};

  const command = firstStringArg(safeArgs, COMMAND_ARG_KEYS);
  if (command) {
    const line = command.trim().split(/\r?\n/)[0] ?? '';
    const withoutCwd = cwd && line.includes(cwd) ? line.split(cwd).join('.') : line;
    return `${toolName}: ${truncate(withoutCwd, COMMAND_PREVIEW_MAX)}`;
  }

  const path = firstStringArg(safeArgs, PATH_ARG_KEYS);
  if (path) {
    return `${toolName}: ${shortenPath(path, cwd)}`;
  }

  const pattern = firstStringArg(safeArgs, PATTERN_ARG_KEYS);
  if (pattern) {
    return `${toolName}: "${truncate(pattern, PATTERN_PREVIEW_MAX)}"`;
  }

  const keys = Object.keys(safeArgs).slice(0, 3).join(',');
  return keys ? `${toolName}(${keys})` : toolName;
};

/**
 * `thinking_*`/`text_*`/`toolcall_*` arrive as start → delta* → end. Only the `*_end` event carries
 * the merged `content`, so deltas emit nothing and one entry is logged per completed block.
 * `toolcall_end` is deliberately silent: the same call is logged from the top-level
 * `tool_execution_start`, whose `toolName`/`args` describe what actually ran.
 */
const parseAssistantMessageEvent = (event: OmpAssistantMessageEvent | undefined): ParsedLogEntry[] => {
  const content = typeof event?.content === 'string' ? event.content.trim() : '';
  if (content.length === 0) {
    return [];
  }

  switch (event?.type) {
    case 'thinking_end':
      return [
        { level: 'INFO', category: 'THINKING', message: `[Thinking] ${truncate(content, THINKING_PREVIEW_MAX)}` },
      ];

    case 'text_end':
      return [{ level: 'INFO', category: 'TEXT', message: firstSentence(content) }];

    default:
      return [];
  }
};

const parseOmpEvent = (parsed: OmpEvent, options?: ParseOptions): ParsedLogEntry[] => {
  switch (parsed.type) {
    case 'session':
      return [{ level: 'INFO', category: 'SYSTEM', message: '[Session started]' }];

    case 'agent_start':
      return [{ level: 'INFO', category: 'SYSTEM', message: '[Agent started]' }];

    case 'turn_start':
      return [{ level: 'INFO', category: 'SYSTEM', message: '[Turn started]' }];

    case 'message_update':
      return parseAssistantMessageEvent(parsed.assistantMessageEvent);

    case 'tool_execution_start': {
      const toolName = parsed.toolName ?? 'unknown';
      const summary = truncate(summarizeOmpTool(toolName, parsed.args, options?.cwd), TOOL_PREVIEW_MAX);
      return [{ level: 'INFO', category: 'TOOL', toolName, message: `[Tool] ${summary}` }];
    }

    case 'tool_execution_end': {
      // omp/18.0.6 puts isError at the event root. Keep the nested check for older producers.
      if (parsed.isError !== true && parsed.result?.isError !== true) {
        return [];
      }
      const toolName = parsed.toolName ?? 'unknown';
      return [{ level: 'WARN', category: 'TOOL', toolName, message: `[Tool] ${toolName} (error)` }];
    }

    default:
      // Unknown top-level types (`notice`, `message_start`, `agent_end`, …) stay out of the log.
      return [];
  }
};

const decodeOmpEvent = (line: string): OmpEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as OmpEvent;
  } catch {
    return null;
  }
};

export const parseOmpJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const parsed = decodeOmpEvent(line);
  return parsed ? parseOmpEvent(parsed, options) : [];
};

const createLineScanner = (scan: (line: string) => void): { push: (chunk: string) => void; flush: () => void } => {
  let buffer = '';

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

/**
 * Line-buffered parser for chunked omp NDJSON stdout. Chunks split mid-line are held until the
 * newline arrives, and each line is trimmed before parsing so CRLF output loses its trailing `\r`.
 */
export const createOmpJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } =>
  createLineScanner((line) => {
    const entries = parseOmpJsonLine(line, options);
    if (entries.length > 0) {
      onEntries(entries);
    }
  });

const joinAssistantText = (content: OmpContentPart[] | undefined): string | null => {
  if (!Array.isArray(content)) {
    return null;
  }
  const joined = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
  return joined.length > 0 ? joined : null;
};

const composeFailureMessage = (message: OmpMessage): string => {
  const detail = (message.errorMessage ?? '').trim();
  const status = typeof message.errorStatus === 'number' ? String(message.errorStatus) : '';

  if (detail.length === 0) {
    return status.length > 0
      ? `Oh My Pi run failed with status ${status}`
      : 'Oh My Pi run failed before producing an answer';
  }

  return truncate(
    status.length > 0 && !detail.startsWith(status) ? `${status} ${detail}` : detail,
    FAILURE_MESSAGE_MAX,
  );
};

type OmpResultState = {
  consume: (event: OmpEvent) => void;
  getFinalText: () => string | null;
  getStreamedTextFallback: () => string | null;
  getFailureMessage: () => string | null;
};

const createOmpResultState = (): OmpResultState => {
  let finalText: string | null = null;
  let streamedTextFallback = '';
  let failureMessage: string | null = null;

  const appendStreamedText = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || streamedTextFallback.length >= STREAMED_TEXT_FALLBACK_MAX) {
      return;
    }
    const separator = streamedTextFallback.length > 0 ? '\n' : '';
    const remaining = STREAMED_TEXT_FALLBACK_MAX - streamedTextFallback.length;
    streamedTextFallback += `${separator}${trimmed}`.slice(0, remaining);
  };

  return {
    consume(parsed) {
      if (
        parsed.type === 'message_update' &&
        parsed.assistantMessageEvent?.type === 'text_end' &&
        typeof parsed.assistantMessageEvent.content === 'string'
      ) {
        appendStreamedText(parsed.assistantMessageEvent.content);
      }

      const message = parsed.message;
      if (!message || message.role !== 'assistant') {
        return;
      }

      // A run can recover in a later turn. Only the latest terminal event decides failure.
      if (parsed.type === 'message_end' || parsed.type === 'turn_end') {
        failureMessage = message.stopReason === 'error' ? composeFailureMessage(message) : null;
        finalText = joinAssistantText(message.content) ?? finalText;
      }
    },
    getFinalText: () => finalText,
    getStreamedTextFallback: () => (streamedTextFallback.length > 0 ? streamedTextFallback : null),
    getFailureMessage: () => failureMessage,
  };
};

/**
 * Accumulates the two facts the runner needs from a finished omp stream:
 *
 * - the final assistant text — the last `message_end`/`turn_end` with `role: "assistant"` that
 *   carries text content. `role` is also `user` (the echoed prompt) and `toolResult`, so filtering
 *   by role is what keeps the prompt out of the answer.
 * - the failure cause — `stopReason: "error"` plus `errorStatus`/`errorMessage`. json mode exits 0
 *   even when the provider rejected the request, so this is the only honest failure signal.
 */
export const createOmpResultCapturer = (): {
  push: (chunk: string) => void;
  flush: () => void;
  getFinalText: () => string | null;
  getStreamedTextFallback: () => string | null;
  getFailureMessage: () => string | null;
} => {
  const state = createOmpResultState();
  const scanner = createLineScanner((line) => {
    const parsed = decodeOmpEvent(line);
    if (parsed) {
      state.consume(parsed);
    }
  });

  return {
    push: scanner.push,
    flush: scanner.flush,
    getFinalText: state.getFinalText,
    getStreamedTextFallback: state.getStreamedTextFallback,
    getFailureMessage: state.getFailureMessage,
  };
};

/**
 * Scans and decodes each NDJSON line once, then fans the event out to live-log parsing and result
 * capture. Long omp runs can emit tens of thousands of delta lines, so the runner uses this
 * combined consumer instead of maintaining two buffers and calling JSON.parse twice per line.
 */
export const createOmpStreamConsumer = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): {
  push: (chunk: string) => void;
  flush: () => void;
  getFinalText: () => string | null;
  getStreamedTextFallback: () => string | null;
  getFailureMessage: () => string | null;
} => {
  const state = createOmpResultState();
  const scanner = createLineScanner((line) => {
    const parsed = decodeOmpEvent(line);
    if (!parsed) {
      return;
    }
    const entries = parseOmpEvent(parsed, options);
    if (entries.length > 0) {
      onEntries(entries);
    }
    state.consume(parsed);
  });

  return {
    push: scanner.push,
    flush: scanner.flush,
    getFinalText: state.getFinalText,
    getStreamedTextFallback: state.getStreamedTextFallback,
    getFailureMessage: state.getFailureMessage,
  };
};
