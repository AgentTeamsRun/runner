/**
 * Parses Claude Code / AMP compatible stream-json lines into structured log entries.
 * Shared by claude-code and amp runners to convert raw JSON output into human-readable logs.
 */

export type ParsedLogEntry = {
  level: "INFO" | "WARN";
  message: string;
};

type StreamJsonLine =
  | { type: "system"; subtype?: string; session_id?: string; tools?: string[]; model?: string }
  | { type: "user"; message?: { content?: Array<{ type: string; text?: string }> } }
  | {
      type: "assistant";
      message?: {
        content?: Array<
          | { type: "thinking"; thinking?: string }
          | { type: "text"; text?: string }
          | { type: "tool_use"; name?: string; id?: string; input?: Record<string, unknown> }
          | { type: "tool_result"; tool_use_id?: string; content?: unknown }
        >;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
    }
  | { type: "result"; subtype?: string; result?: string; is_error?: boolean; duration_ms?: number; num_turns?: number };

const THINKING_PREVIEW_MAX = 300;
const TEXT_PREVIEW_MAX = 500;
const TOOL_INPUT_PREVIEW_MAX = 200;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

export const parseStreamJsonLine = (line: string): ParsedLogEntry[] => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: StreamJsonLine;
  try {
    parsed = JSON.parse(trimmed) as StreamJsonLine;
  } catch {
    return [];
  }

  if (!parsed.type) {
    return [];
  }

  const entries: ParsedLogEntry[] = [];

  switch (parsed.type) {
    case "system": {
      if (parsed.subtype === "init") {
        const toolCount = parsed.tools?.length ?? 0;
        const model = parsed.model ?? "unknown";
        entries.push({ level: "INFO", message: `Session initialized (model=${model}, tools=${toolCount})` });
      }
      break;
    }

    case "assistant": {
      const content = parsed.message?.content;
      if (!Array.isArray(content)) {
        break;
      }

      for (const block of content) {
        switch (block.type) {
          case "thinking": {
            const thinking = (block as { thinking?: string }).thinking;
            if (thinking && thinking.trim().length > 0) {
              entries.push({ level: "INFO", message: `[Thinking] ${truncate(thinking.trim(), THINKING_PREVIEW_MAX)}` });
            }
            break;
          }
          case "text": {
            const text = (block as { text?: string }).text;
            if (text && text.trim().length > 0) {
              entries.push({ level: "INFO", message: truncate(text.trim(), TEXT_PREVIEW_MAX) });
            }
            break;
          }
          case "tool_use": {
            const toolBlock = block as { name?: string; input?: Record<string, unknown> };
            const name = toolBlock.name ?? "unknown";
            const inputPreview = toolBlock.input
              ? truncate(JSON.stringify(toolBlock.input), TOOL_INPUT_PREVIEW_MAX)
              : "";
            entries.push({ level: "INFO", message: inputPreview ? `[Tool] ${name}: ${inputPreview}` : `[Tool] ${name}` });
            break;
          }
          default:
            break;
        }
      }
      break;
    }

    case "result": {
      const duration = parsed.duration_ms ? `${Math.round(parsed.duration_ms / 1000)}s` : "unknown";
      const turns = parsed.num_turns ?? 0;
      if (parsed.is_error) {
        const result = parsed.result ?? "Unknown error";
        entries.push({ level: "WARN", message: `[Result] Error after ${duration} (${turns} turns): ${truncate(result, TEXT_PREVIEW_MAX)}` });
      } else {
        entries.push({ level: "INFO", message: `[Result] Completed in ${duration} (${turns} turns)` });
      }
      break;
    }

    default:
      break;
  }

  return entries;
};

/**
 * Creates a line-buffered parser that handles chunked stdout data.
 * Stream data may arrive as partial lines, so this buffers until newlines.
 */
export const createStreamJsonLineParser = (
  onEntries: (entries: ParsedLogEntry[]) => void
): { push: (chunk: string) => void; flush: () => void } => {
  let buffer = "";

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const entries = parseStreamJsonLine(line);
        if (entries.length > 0) {
          onEntries(entries);
        }
      }
    },
    flush() {
      if (buffer.trim().length > 0) {
        const entries = parseStreamJsonLine(buffer);
        if (entries.length > 0) {
          onEntries(entries);
        }
      }
      buffer = "";
    }
  };
};
