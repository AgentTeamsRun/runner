/**
 * Parses OpenCode `run --format json` events into human-readable log entries and extracts the
 * final assistant text. OpenCode emits one JSON object per line shaped as
 *   { type, timestamp, sessionID, part: { type, ... } }
 * where `part.type` is one of: text | reasoning | tool | patch | step-start | step-finish.
 *
 * Mirrors stream-json-parser.ts (Claude/AMP) so OpenCode runs are refined the same way instead of
 * dumping raw TUI/JSON output as fallback history.
 */

import type { ParseOptions, ParsedLogEntry } from './stream-json-parser.js';
import { firstSentence, shortenPath } from './stream-json-parser.js';

const TOOL_PREVIEW_MAX = 120;
const BASH_PREVIEW_MAX = 100;
const REASONING_PREVIEW_MAX = 300;
const PATCH_FILES_MAX = 4;

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

type OpenCodePart = {
  type?: string;
  text?: string;
  messageID?: string;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown>; error?: string };
  files?: string[];
  reason?: string;
  tokens?: { output?: number };
  cost?: number;
};

type OpenCodeEvent = { type?: string; part?: OpenCodePart };

const isVerboseEnabled = (options?: ParseOptions): boolean => {
  if (options && typeof options.verbose === 'boolean') {
    return options.verbose;
  }

  return process.env.AGENTTEAMS_RUNNER_VERBOSE === '1';
};

const stringField = (input: Record<string, unknown> | undefined, key: string): string => {
  const value = input?.[key];
  return typeof value === 'string' ? value : '';
};

export const summarizeOpenCodeTool = (
  tool: string,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): string => {
  const safeInput = input ?? {};

  switch (tool) {
    case 'bash': {
      const raw = stringField(safeInput, 'command').trim().split(/\r?\n/)[0] ?? '';
      const command = cwd && raw.includes(cwd) ? raw.split(cwd).join('.') : raw;
      return command ? `bash: ${truncate(command, BASH_PREVIEW_MAX)}` : 'bash';
    }

    case 'read':
    case 'edit':
    case 'write': {
      const filePath = stringField(safeInput, 'filePath') || stringField(safeInput, 'file_path');
      return filePath ? `${tool}: ${shortenPath(filePath, cwd)}` : tool;
    }

    case 'grep': {
      const pattern = stringField(safeInput, 'pattern');
      const path = stringField(safeInput, 'path');
      const location = path ? ` in ${shortenPath(path, cwd)}` : '';
      return pattern ? `grep: "${truncate(pattern, 60)}"${location}` : 'grep';
    }

    case 'glob':
    case 'list': {
      const target = stringField(safeInput, 'pattern') || stringField(safeInput, 'path');
      return target ? `${tool}: ${shortenPath(target, cwd)}` : tool;
    }

    case 'webfetch': {
      const url = stringField(safeInput, 'url');
      return url ? `webfetch: ${truncate(url, 100)}` : 'webfetch';
    }

    case 'task': {
      const description = stringField(safeInput, 'description');
      return description ? `task: ${truncate(description, 80)}` : 'task';
    }

    default: {
      const keys = Object.keys(safeInput).slice(0, 3).join(',');
      return keys ? `${tool}(${keys})` : tool;
    }
  }
};

export const parseOpenCodeJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: OpenCodeEvent;
  try {
    parsed = JSON.parse(trimmed) as OpenCodeEvent;
  } catch {
    return [];
  }

  const part = parsed.part;
  if (!part || !part.type) {
    return [];
  }

  const verbose = isVerboseEnabled(options);
  const cwd = options?.cwd;

  switch (part.type) {
    case 'text': {
      const text = part.text;
      if (text && text.trim().length > 0) {
        return [{ level: 'INFO', message: firstSentence(text) }];
      }
      return [];
    }

    case 'reasoning': {
      if (!verbose) {
        return [];
      }
      const text = part.text;
      if (text && text.trim().length > 0) {
        return [{ level: 'INFO', message: `[Thinking] ${truncate(text.trim(), REASONING_PREVIEW_MAX)}` }];
      }
      return [];
    }

    case 'tool': {
      // Tool parts stream once per state transition; only surface the terminal state to avoid
      // duplicate log lines and to capture failures.
      const status = part.state?.status;
      if (status !== 'completed' && status !== 'error') {
        return [];
      }
      const summary = truncate(summarizeOpenCodeTool(part.tool ?? 'unknown', part.state?.input, cwd), TOOL_PREVIEW_MAX);
      return [
        {
          level: status === 'error' ? 'WARN' : 'INFO',
          message: `[Tool] ${summary}${status === 'error' ? ' (error)' : ''}`,
        },
      ];
    }

    case 'patch': {
      const files = Array.isArray(part.files) ? part.files : [];
      if (files.length === 0) {
        return [];
      }
      const shown = files.slice(0, PATCH_FILES_MAX).map((file) => shortenPath(file, cwd));
      const extra = files.length > PATCH_FILES_MAX ? ` (+${files.length - PATCH_FILES_MAX} more)` : '';
      return [{ level: 'INFO', message: `[Patch] ${shown.join(', ')}${extra}` }];
    }

    case 'step-finish': {
      const reason = part.reason ?? 'unknown';
      const outputTokens = part.tokens?.output;
      const cost = typeof part.cost === 'number' ? `, $${part.cost.toFixed(4)}` : '';
      const tokens = typeof outputTokens === 'number' ? `, ${outputTokens} out tok` : '';
      return [{ level: 'INFO', message: `[Step finished: ${reason}${tokens}${cost}]` }];
    }

    default:
      return [];
  }
};

/**
 * Line-buffered parser for chunked OpenCode JSON stdout.
 */
export const createOpenCodeJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } => {
  let buffer = '';

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const entries = parseOpenCodeJsonLine(line, options);
        if (entries.length > 0) {
          onEntries(entries);
        }
      }
    },
    flush() {
      if (buffer.trim().length > 0) {
        const entries = parseOpenCodeJsonLine(buffer, options);
        if (entries.length > 0) {
          onEntries(entries);
        }
      }
      buffer = '';
    },
  };
};

const collectTextPartsByMessage = (line: string, texts: Map<string, string[]>): string | null => {
  const trimmed = line.trim();
  if (!trimmed.includes('"type":"text"')) {
    return null;
  }

  let parsed: OpenCodeEvent;
  try {
    parsed = JSON.parse(trimmed) as OpenCodeEvent;
  } catch {
    return null;
  }

  const part = parsed.part;
  if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length === 0) {
    return null;
  }

  const messageId = part.messageID ?? '';
  const existing = texts.get(messageId);
  if (existing) {
    existing.push(part.text);
  } else {
    texts.set(messageId, [part.text]);
  }
  return messageId;
};

const joinMessageText = (texts: Map<string, string[]>, messageId: string | null): string | null => {
  if (messageId === null) {
    return null;
  }
  const parts = texts.get(messageId);
  if (!parts) {
    return null;
  }
  const joined = parts.join('').trim();
  return joined.length > 0 ? joined : null;
};

/**
 * Extracts the final assistant message text from a complete OpenCode JSON transcript. Returns the
 * concatenated `text` parts of the last assistant message, or the raw input when none is found.
 * Analogous to extractResultTextFromStreamJson for Claude/AMP.
 */
export const extractFinalTextFromOpenCodeJson = (outputText: string): string => {
  const trimmedOutput = outputText.trim();
  const texts = new Map<string, string[]>();
  let lastMessageId: string | null = null;

  for (const line of trimmedOutput.split(/\r?\n/)) {
    const messageId = collectTextPartsByMessage(line, texts);
    if (messageId !== null) {
      lastMessageId = messageId;
    }
  }

  return joinMessageText(texts, lastMessageId) ?? trimmedOutput;
};

/**
 * Captures the final assistant text incrementally so it survives the runner's head-capped output
 * buffer on long runs (the closing `text` parts arrive at the end of the stream).
 */
export const createOpenCodeFinalTextCapturer = (): {
  push: (chunk: string) => void;
  flush: () => void;
  get: () => string | null;
} => {
  let buffer = '';
  const texts = new Map<string, string[]>();
  let lastMessageId: string | null = null;

  const scan = (line: string): void => {
    const messageId = collectTextPartsByMessage(line, texts);
    if (messageId !== null) {
      lastMessageId = messageId;
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
      if (buffer.length > 0) {
        scan(buffer);
      }
      buffer = '';
    },
    get: () => joinMessageText(texts, lastMessageId),
  };
};
