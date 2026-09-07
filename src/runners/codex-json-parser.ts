/**
 * Parses Codex `exec --json` JSONL events into the shared readable log vocabulary.
 *
 * Only terminal item events are surfaced. In particular, command `aggregated_output` and file
 * contents are never copied into log messages.
 */

import { createJsonLineBuffer } from './json-line-buffer.js';
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

const decodeCodexEvent = (line: string): CodexEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
};

const parseCodexEvent = (parsed: CodexEvent, options?: ParseOptions): ParsedLogEntry[] => {
  if (parsed.type === 'turn.completed') {
    return [{ level: 'INFO', category: 'RESULT', message: '[Result] Completed' }];
  }

  if (parsed.type === 'turn.failed' || parsed.type === 'error') {
    const detail = firstSentence(failureMessage(parsed), 160);
    return [{ level: 'WARN', category: 'RESULT', message: detail ? `[Result] Failed: ${detail}` : '[Result] Failed' }];
  }

  if (parsed.type !== 'item.completed' || !parsed.item?.type) {
    return [];
  }

  const item = parsed.item;
  switch (item.type) {
    case 'agent_message': {
      return typeof item.text === 'string' && item.text.trim().length > 0
        ? [{ level: 'INFO', category: 'TEXT', message: firstSentence(item.text) }]
        : [];
    }

    case 'reasoning': {
      if (!isVerboseEnabled(options) || typeof item.text !== 'string' || item.text.trim().length === 0) {
        return [];
      }
      return [
        {
          level: 'INFO',
          category: 'THINKING',
          message: `[Thinking] ${truncate(item.text.trim(), REASONING_PREVIEW_MAX)}`,
        },
      ];
    }

    case 'command_execution': {
      const summary = summarizeCommand(item.command ?? '', options?.cwd);
      const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      return [
        {
          level: failed ? 'WARN' : 'INFO',
          category: 'TOOL',
          toolName: 'Bash',
          message: `[Tool] ${summary}${failed ? ' (failed)' : ''}`,
        },
      ];
    }

    case 'file_change': {
      const summary = summarizeFileChanges(item.changes, options?.cwd);
      return summary
        ? [
            {
              level: item.status === 'failed' ? 'WARN' : 'INFO',
              category: 'TOOL',
              toolName: 'File change',
              message: `[Tool] ${summary}`,
            },
          ]
        : [];
    }

    case 'mcp_tool_call': {
      const toolName = [item.server, item.tool ?? item.name].filter(Boolean).join('.');
      return toolName
        ? [
            {
              level: item.status === 'failed' ? 'WARN' : 'INFO',
              category: 'TOOL',
              toolName,
              message: `[Tool] ${toolName}`,
            },
          ]
        : [];
    }

    case 'web_search': {
      const query = typeof item.query === 'string' ? truncate(item.query.trim(), COMMAND_PREVIEW_MAX) : '';
      return [
        {
          level: 'INFO',
          category: 'TOOL',
          toolName: 'Web search',
          message: query ? `[Tool] Web search: ${query}` : '[Tool] Web search',
        },
      ];
    }

    default:
      return [];
  }
};

export const parseCodexJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const parsed = decodeCodexEvent(line);
  return parsed ? parseCodexEvent(parsed, options) : [];
};

// 한 줄을 한 번만 디코드해 로그 정제와 사용량 수집에 팬아웃한다.
// stdout 원문을 수집기 push에 직접 넣으면 라인당 JSON.parse가 두 번 돌므로,
// claude-code/opencode 선례대로 파서 계약 확장 방식을 쓴다.
export const createCodexJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } =>
  createJsonLineBuffer((line) => {
    const parsed = decodeCodexEvent(line);
    if (parsed) {
      options?.onEvent?.(parsed);
      const entries = parseCodexEvent(parsed, options);
      if (entries.length > 0) {
        onEntries(entries);
      }
    }
  }, options?.onDropped);

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
