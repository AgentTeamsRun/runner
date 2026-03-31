/**
 * Minimal YAML parser for harness.yml.
 *
 * Supports: key-value pairs, nested objects, arrays with `-` prefix,
 * basic scalar types (string, number, boolean, null).
 * Does NOT support: anchors, aliases, multi-line strings, flow style.
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const parseScalar = (raw: string): string | number | boolean | null => {
  const trimmed = raw.trim();

  if (trimmed === "" || trimmed === "null" || trimmed === "~") {
    return null;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  // Quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Number
  const num = Number(trimmed);
  if (trimmed.length > 0 && !Number.isNaN(num)) {
    return num;
  }

  return trimmed;
};

const getIndent = (line: string): number => {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
};

export const parseYaml = (text: string): YamlValue => {
  const lines = text.split("\n").filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });

  if (lines.length === 0) {
    return {};
  }

  return parseBlock(lines, 0, lines.length, 0);
};

const parseBlock = (
  lines: string[],
  start: number,
  end: number,
  baseIndent: number
): YamlValue => {
  if (start >= end) {
    return {};
  }

  const firstLine = lines[start]!.trim();

  // Check if this block is an array (first line starts with "- ")
  if (firstLine.startsWith("- ")) {
    return parseArray(lines, start, end, baseIndent);
  }

  return parseObject(lines, start, end, baseIndent);
};

const parseObject = (
  lines: string[],
  start: number,
  end: number,
  baseIndent: number
): { [key: string]: YamlValue } => {
  const result: { [key: string]: YamlValue } = {};
  let i = start;

  while (i < end) {
    const line = lines[i]!;
    const indent = getIndent(line);

    if (indent < baseIndent) {
      break;
    }

    if (indent > baseIndent) {
      i += 1;
      continue;
    }

    const trimmed = line.trim();
    const colonIndex = trimmed.indexOf(":");

    if (colonIndex === -1) {
      i += 1;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const afterColon = trimmed.slice(colonIndex + 1).trim();

    if (afterColon.length > 0) {
      // Inline value
      result[key] = parseScalar(afterColon);
      i += 1;
    } else {
      // Block value — find children
      const childStart = i + 1;
      let childEnd = childStart;

      while (childEnd < end) {
        const childIndent = getIndent(lines[childEnd]!);
        if (childIndent <= baseIndent) {
          break;
        }
        childEnd += 1;
      }

      if (childStart < childEnd) {
        const childIndent = getIndent(lines[childStart]!);
        result[key] = parseBlock(lines, childStart, childEnd, childIndent);
      } else {
        result[key] = null;
      }

      i = childEnd;
    }
  }

  return result;
};

const parseArray = (
  lines: string[],
  start: number,
  end: number,
  baseIndent: number
): YamlValue[] => {
  const result: YamlValue[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i]!;
    const indent = getIndent(line);

    if (indent < baseIndent) {
      break;
    }

    if (indent > baseIndent) {
      i += 1;
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed.startsWith("- ")) {
      i += 1;
      continue;
    }

    const afterDash = trimmed.slice(2);

    // Check if this is "- key: value" (object item)
    const colonIndex = afterDash.indexOf(":");
    if (colonIndex > 0) {
      // Gather all lines for this array item
      const itemLines: string[] = [];
      // Re-indent the first line (remove the "- " prefix)
      const itemIndent = indent + 2;
      itemLines.push(" ".repeat(itemIndent) + afterDash);

      let j = i + 1;
      while (j < end) {
        const nextIndent = getIndent(lines[j]!);
        if (nextIndent <= baseIndent) {
          break;
        }
        itemLines.push(lines[j]!);
        j += 1;
      }

      result.push(parseObject(itemLines, 0, itemLines.length, itemIndent));
      i = j;
    } else {
      // Simple scalar item
      result.push(parseScalar(afterDash));
      i += 1;
    }
  }

  return result;
};
