/**
 * Parses Codex `exec --json` JSONL events into the shared readable log vocabulary.
 *
 * Only terminal item events are surfaced. In particular, command `aggregated_output` and file
 * contents are never copied into log messages.
 */

import type { ParseOptions, ParsedLogEntry } from './stream-json-parser.js';
import { firstSentence, shortenPath } from './stream-json-parser.js';

const COMMAND_PREVIEW_MAX = 100;
const REASONING_PREVIEW_MAX = 300;
const FILES_PREVIEW_MAX = 4;

type CodexItem = {
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number | null;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  name?: string;
  query?: string;
};

type CodexEvent = {
  type?: string;
  item?: CodexItem;
  error?: { message?: string } | string;
  message?: string;
};

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

const isVerboseEnabled = (options?: ParseOptions): boolean => {
  if (options && typeof options.verbose === 'boolean') {
    return options.verbose;
  }

  return process.env.AGENTTEAMS_RUNNER_VERBOSE === '1';
};

const unwrapShellCommand = (command: string): string => {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:\/bin\/(?:ba|z|da)?sh|(?:ba|z|da)?sh)\s+-lc\s+(["'])([\s\S]*)\1$/);
  return (match?.[2] ?? trimmed).trim();
};

const summarizeCommand = (command: string, cwd?: string): string => {
  const firstLine = unwrapShellCommand(command).split(/\r?\n/)[0]?.trim() ?? '';
  const relative = cwd && firstLine.includes(cwd) ? firstLine.split(cwd).join('.') : firstLine;
  return relative.length > 0 ? `Bash: ${truncate(relative, COMMAND_PREVIEW_MAX)}` : 'Bash';
};

const summarizeFileChanges = (changes: CodexItem['changes'], cwd?: string): string | null => {
  if (!Array.isArray(changes) || changes.length === 0) {
    return null;
  }

  const shown = changes.slice(0, FILES_PREVIEW_MAX).map((change) => {
    const path = typeof change.path === 'string' ? shortenPath(change.path, cwd) : 'unknown';
    return change.kind ? `${path} (${change.kind})` : path;
  });
  const extra = changes.length > FILES_PREVIEW_MAX ? ` (+${changes.length - FILES_PREVIEW_MAX} more)` : '';
  return `File change: ${shown.join(', ')}${extra}`;
};

const failureMessage = (parsed: CodexEvent): string => {
  if (typeof parsed.error === 'string') {
    return parsed.error;
  }
  if (parsed.error && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  return typeof parsed.message === 'string' ? parsed.message : '';
};

export const parseCodexJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: CodexEvent;
  try {
    parsed = JSON.parse(trimmed) as CodexEvent;
  } catch {
    return [];
  }

  if (parsed.type === 'turn.completed') {
    return [{ level: 'INFO', message: '[Result] Completed' }];
  }

  if (parsed.type === 'turn.failed' || parsed.type === 'error') {
    const detail = firstSentence(failureMessage(parsed), 160);
    return [{ level: 'WARN', message: detail ? `[Result] Failed: ${detail}` : '[Result] Failed' }];
  }

  if (parsed.type !== 'item.completed' || !parsed.item?.type) {
    return [];
  }

  const item = parsed.item;
  switch (item.type) {
    case 'agent_message': {
      return typeof item.text === 'string' && item.text.trim().length > 0
        ? [{ level: 'INFO', message: firstSentence(item.text) }]
        : [];
    }

    case 'reasoning': {
      if (!isVerboseEnabled(options) || typeof item.text !== 'string' || item.text.trim().length === 0) {
        return [];
      }
      return [{ level: 'INFO', message: `[Thinking] ${truncate(item.text.trim(), REASONING_PREVIEW_MAX)}` }];
    }

    case 'command_execution': {
      const summary = summarizeCommand(item.command ?? '', options?.cwd);
      const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      return [{ level: failed ? 'WARN' : 'INFO', message: `[Tool] ${summary}${failed ? ' (failed)' : ''}` }];
    }

    case 'file_change': {
      const summary = summarizeFileChanges(item.changes, options?.cwd);
      return summary ? [{ level: item.status === 'failed' ? 'WARN' : 'INFO', message: `[Tool] ${summary}` }] : [];
    }

    case 'mcp_tool_call': {
      const toolName = [item.server, item.tool ?? item.name].filter(Boolean).join('.');
      return toolName ? [{ level: item.status === 'failed' ? 'WARN' : 'INFO', message: `[Tool] ${toolName}` }] : [];
    }

    case 'web_search': {
      const query = typeof item.query === 'string' ? truncate(item.query.trim(), COMMAND_PREVIEW_MAX) : '';
      return [{ level: 'INFO', message: query ? `[Tool] Web search: ${query}` : '[Tool] Web search' }];
    }

    default:
      return [];
  }
};

export const createCodexJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } => {
  let buffer = '';

  const scan = (line: string): void => {
    const entries = parseCodexJsonLine(line, options);
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
  let parsed: CodexEvent;
  try {
    parsed = JSON.parse(line.trim()) as CodexEvent;
  } catch {
    return null;
  }

  const item = parsed.item;
  return parsed.type === 'item.completed' &&
    item?.type === 'agent_message' &&
    typeof item.text === 'string' &&
    item.text.trim().length > 0
    ? item.text.trim()
    : null;
};

export const createCodexFinalTextCapturer = (): {
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
