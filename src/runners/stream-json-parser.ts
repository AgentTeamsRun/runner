/**
 * Parses Claude Code / AMP compatible stream-json lines into structured log entries.
 * Shared by claude-code and amp runners to convert raw JSON output into human-readable logs.
 */

export type ParsedLogEntry = {
  level: "INFO" | "WARN";
  message: string;
};

export type ParseOptions = {
  cwd?: string;
  verbose?: boolean;
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
const TEXT_PREVIEW_MAX = 160;
const TOOL_PREVIEW_MAX = 120;
const BASH_PREVIEW_MAX = 100;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

const isVerboseEnabled = (options?: ParseOptions): boolean => {
  if (options && typeof options.verbose === "boolean") {
    return options.verbose;
  }

  return process.env.AGENTTEAMS_RUNNER_VERBOSE === "1";
};

export const shortenPath = (path: string, cwd?: string): string => {
  if (!path) {
    return "";
  }

  if (cwd && path.startsWith(cwd)) {
    const relative = path.slice(cwd.length).replace(/^\/+/, "");
    return relative.length > 0 ? relative : path;
  }

  return path;
};

export const firstSentence = (text: string, cap: number = TEXT_PREVIEW_MAX): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^.*?[.!?。](?:\s|$)/);
  const candidate = match ? match[0].trim() : normalized;
  return truncate(candidate, cap);
};

const stringField = (input: Record<string, unknown> | undefined, key: string): string => {
  const value = input?.[key];
  return typeof value === "string" ? value : "";
};

export const summarizeToolUse = (
  name: string,
  input: Record<string, unknown> | undefined,
  cwd?: string
): string => {
  const safeInput = input ?? {};

  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const filePath = stringField(safeInput, "file_path");
      return filePath ? `${name}: ${shortenPath(filePath, cwd)}` : name;
    }

    case "Bash": {
      const raw = stringField(safeInput, "command").trim().split(/\r?\n/)[0] ?? "";
      const command = cwd && raw.includes(cwd) ? raw.split(cwd).join(".") : raw;
      return command ? `Bash: ${truncate(command, BASH_PREVIEW_MAX)}` : "Bash";
    }

    case "Grep": {
      const pattern = stringField(safeInput, "pattern");
      const path = stringField(safeInput, "path");
      const location = path ? ` in ${shortenPath(path, cwd)}` : "";
      return pattern ? `Grep: "${truncate(pattern, 60)}"${location}` : "Grep";
    }

    case "Glob": {
      const pattern = stringField(safeInput, "pattern");
      return pattern ? `Glob: ${pattern}` : "Glob";
    }

    case "Task": {
      const description = stringField(safeInput, "description");
      return description ? `Task: ${truncate(description, 80)}` : "Task";
    }

    case "TaskCreate": {
      const subject = stringField(safeInput, "subject");
      return subject ? `TaskCreate: ${truncate(subject, 80)}` : "TaskCreate";
    }

    case "TaskUpdate": {
      const taskId = stringField(safeInput, "taskId");
      const status = stringField(safeInput, "status");
      if (taskId && status) {
        return `TaskUpdate: ${taskId} -> ${status}`;
      }
      return taskId ? `TaskUpdate: ${taskId}` : "TaskUpdate";
    }

    case "TodoWrite": {
      const todos = safeInput.todos;
      const count = Array.isArray(todos) ? todos.length : 0;
      return `TodoWrite: ${count} item(s)`;
    }

    case "WebSearch": {
      const query = stringField(safeInput, "query");
      return query ? `WebSearch: "${truncate(query, 80)}"` : "WebSearch";
    }

    case "WebFetch": {
      const url = stringField(safeInput, "url");
      return url ? `WebFetch: ${truncate(url, 100)}` : "WebFetch";
    }

    case "ToolSearch": {
      const query = stringField(safeInput, "query");
      return query ? `ToolSearch: ${truncate(query, 80)}` : "ToolSearch";
    }

    default: {
      const keys = Object.keys(safeInput).slice(0, 3).join(",");
      return keys ? `${name}(${keys})` : name;
    }
  }
};

export const parseStreamJsonLine = (line: string, options?: ParseOptions): ParsedLogEntry[] => {
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

  const verbose = isVerboseEnabled(options);
  const cwd = options?.cwd;
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
            if (!verbose) {
              break;
            }
            const thinking = (block as { thinking?: string }).thinking;
            if (thinking && thinking.trim().length > 0) {
              entries.push({ level: "INFO", message: `[Thinking] ${truncate(thinking.trim(), THINKING_PREVIEW_MAX)}` });
            }
            break;
          }
          case "text": {
            const text = (block as { text?: string }).text;
            if (text && text.trim().length > 0) {
              entries.push({ level: "INFO", message: firstSentence(text) });
            }
            break;
          }
          case "tool_use": {
            const toolBlock = block as { name?: string; input?: Record<string, unknown> };
            const name = toolBlock.name ?? "unknown";
            const summary = truncate(summarizeToolUse(name, toolBlock.input, cwd), TOOL_PREVIEW_MAX);
            entries.push({ level: "INFO", message: `[Tool] ${summary}` });
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
        entries.push({ level: "WARN", message: `[Result] Error after ${duration} (${turns} turns): ${truncate(result, 300)}` });
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
  onEntries: (entries: ParsedLogEntry[]) => void,
  options?: ParseOptions
): { push: (chunk: string) => void; flush: () => void } => {
  let buffer = "";

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const entries = parseStreamJsonLine(line, options);
        if (entries.length > 0) {
          onEntries(entries);
        }
      }
    },
    flush() {
      if (buffer.trim().length > 0) {
        const entries = parseStreamJsonLine(buffer, options);
        if (entries.length > 0) {
          onEntries(entries);
        }
      }
      buffer = "";
    }
  };
};
