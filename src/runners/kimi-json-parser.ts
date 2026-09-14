/**
 * Parses Kimi Code CLI `--output-format stream-json` JSONL events into the shared readable log vocabulary.
 *
 * Measured against kimi 0.42.0: every line carries a `role` (`meta` / `assistant` / `tool`).
 * Assistant lines hold either `content` text or `tool_calls` with a JSON-encoded `arguments`
 * string. Tool lines hold the raw tool body, which is never copied into log messages.
 * This schema is incompatible with the Claude-style `type: system/assistant/result` contract,
 * so the shared `createStreamJsonLineParser` cannot be reused here.
 *
 * Token usage is not present on this stdout contract. The 0.42.0 success schema is
 * `fixtures/kimi-events.jsonl` (roles only; no integer usage fields). A 2026-09-13
 * print-mode re-probe of the same version (`kimi -p … --output-format stream-json`)
 * emitted `system.version` (`fixtures/kimi-print-mode.jsonl`) then exited 1 with
 * provider 429 (insufficient balance), so it did not add new event types. Official
 * docs describe Assistant/Tool lines only. Session-directory internal logs are not
 * this stdout contract and are not collected. Do not invent token counts from text
 * length or other files.
 */

import { createJsonLineBuffer } from './json-line-buffer.js';
import type { ParseOptions, ParsedLogEntry } from './stream-json-parser.js';
import { firstSentence, shortenPath } from './stream-json-parser.js';

const TOOL_PREVIEW_MAX = 120;
const COMMAND_PREVIEW_MAX = 100;

type KimiToolCall = {
  type?: string;
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type KimiEvent = {
  role?: string;
  type?: string;
  content?: unknown;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
};

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

const stringField = (input: Record<string, unknown> | undefined, key: string): string => {
  const value = input?.[key];
  return typeof value === 'string' ? value : '';
};

const decodeArguments = (args: unknown): Record<string, unknown> => {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string' && args.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
};

export const summarizeKimiTool = (
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

const decodeKimiEvent = (line: string): KimiEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as KimiEvent;
  } catch {
    return null;
  }
};

const parseKimiEvent = (parsed: KimiEvent, options?: ParseOptions): ParsedLogEntry[] => {
  if (!parsed || typeof parsed !== 'object' || parsed.role !== 'assistant') {
    return [];
  }

  const entries: ParsedLogEntry[] = [];
  if (typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
    entries.push({ level: 'INFO', category: 'TEXT', message: firstSentence(parsed.content) });
  }

  if (Array.isArray(parsed.tool_calls)) {
    for (const toolCall of parsed.tool_calls) {
      const name = toolCall?.function?.name?.trim() || 'unknown';
      const summary = truncate(
        summarizeKimiTool(name, decodeArguments(toolCall?.function?.arguments), options?.cwd),
        TOOL_PREVIEW_MAX,
      );
      entries.push({ level: 'INFO', category: 'TOOL', toolName: name, message: `[Tool] ${summary}` });
    }
  }

  return entries;
};

export const parseKimiJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
  const parsed = decodeKimiEvent(line);
  return parsed ? parseKimiEvent(parsed, options) : [];
};

// 한 줄을 한 번만 디코드해 로그 정제와 수집에 팬아웃한다.
// stdout 원문을 수집기 push에 직접 넣으면 라인당 JSON.parse가 두 번 돌므로,
// codex/copilot 선례대로 파서 계약 확장 방식을 쓴다.
export const createKimiJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions,
): { push: (chunk: string) => void; flush: () => void } =>
  createJsonLineBuffer((line) => {
    const parsed = decodeKimiEvent(line);
    if (parsed) {
      options?.onEvent?.(parsed);
      const entries = parseKimiEvent(parsed, options);
      if (entries.length > 0) {
        onEntries(entries);
      }
    }
  }, options?.onDropped);

const assistantText = (line: string): string | null => {
  let parsed: KimiEvent;
  try {
    parsed = JSON.parse(line.trim()) as KimiEvent;
  } catch {
    return null;
  }

  const content = parsed.content;
  return parsed.role === 'assistant' && typeof content === 'string' && content.trim().length > 0
    ? content.trim()
    : null;
};

export const createKimiFinalTextCapturer = (): {
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
