import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { RunnerType } from '@agentteams/core-constants';
import { resolveExecutablePathWithPreference } from '../executable.js';
import { sanitizeAntigravityInternalLogLine } from '../runners/antigravity.js';
import { RUNNER_CAPABILITIES } from '../runners/capabilities.js';
import { getGrokExecutablePreference } from '../runners/grok-build.js';
import { getKiroExecutablePreference } from '../runners/kiro-cli.js';

const RESERVED_MODEL_PREFIX = '__fast__:';
const ENUMERATION_TIMEOUT_MS = 30_000;
const MAX_ERROR_OUTPUT_LENGTH = 500;

export const sanitizeErrorOutput = (output: string): string => {
  const trimmed = output.trim();
  if (trimmed.length === 0) return '';
  const sanitized = sanitizeAntigravityInternalLogLine(trimmed);
  if (sanitized.length <= MAX_ERROR_OUTPUT_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_ERROR_OUTPUT_LENGTH)}...`;
};

export type EnumeratedModel = {
  value: string;
  label: string;
  maxInputTokens?: number;
};

export type ModelEnumerationResult =
  | { status: 'SUCCESS'; values: EnumeratedModel[] }
  | { status: 'UNSUPPORTED' | 'EMPTY_OUTPUT' | 'FORMAT_MISMATCH' | 'COMMAND_FAILED'; message?: string };

export type ModelEnumeratorDependencies = {
  execute: (executablePath: string, args: string[]) => Promise<{ stdout: string }>;
  platform: () => NodeJS.Platform;
  resolveExecutable: (name: string, preferredNames: string[]) => string;
};

export const executeModelEnumerationCommand = (
  executablePath: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxBufferBytes?: number;
  } = {},
): Promise<{ stdout: string }> => {
  const timeoutMs = options.timeoutMs ?? ENUMERATION_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBytes += Buffer.byteLength(str);
      if (stdoutBytes > maxBuffer && !killed) {
        killed = true;
        child.kill('SIGKILL');
        clearTimeout(timer);
        reject(new Error(`stdout maxBuffer exceeded (${maxBuffer} bytes)`));
        return;
      }
      stdout += str;
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length < 64 * 1024) {
        stderr += str.slice(0, 64 * 1024 - stderr.length);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${executablePath} ${args.join(' ')}`));
        return;
      }
      if (code !== 0) {
        const exitInfo = signal ? `signal ${signal}` : `exit code ${code}`;
        const trimmedStderr = stderr.trim();
        const rawMessage = trimmedStderr
          ? `Command failed (${exitInfo}): ${executablePath} ${args.join(' ')}\n${trimmedStderr}`
          : `Command failed (${exitInfo}): ${executablePath} ${args.join(' ')}`;
        reject(new Error(sanitizeErrorOutput(rawMessage)));
        return;
      }
      resolve({ stdout });
    });
  });
};

const defaultDependencies: ModelEnumeratorDependencies = {
  execute: (executablePath, args) => executeModelEnumerationCommand(executablePath, args),
  platform,
  resolveExecutable: resolveExecutablePathWithPreference,
};

// API의 value/label은 255자를 넘으면 요청을 거절하므로 러너에서 먼저 자른다.
// 255자를 넘는 value는 모델 식별자로 볼 수 없으니 자르지 않고 버린다.
const MAX_FIELD_LENGTH = 255;

const normalizeModels = (models: EnumeratedModel[]): EnumeratedModel[] => {
  const seen = new Set<string>();

  return models.filter((model) => {
    const value = model.value.trim();
    if (value.length === 0 || value.length > MAX_FIELD_LENGTH || value.startsWith(RESERVED_MODEL_PREFIX)) {
      return false;
    }
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    model.value = value;
    model.label = (model.label.trim() || value).slice(0, MAX_FIELD_LENGTH);
    return true;
  });
};

const parsedResult = (output: string, models: EnumeratedModel[]): ModelEnumerationResult => {
  if (output.trim().length === 0) {
    return { status: 'EMPTY_OUTPUT' };
  }

  const values = normalizeModels(models);
  return values.length > 0 ? { status: 'SUCCESS', values } : { status: 'FORMAT_MISMATCH' };
};

export const parseKiroModels = (output: string): ModelEnumerationResult => {
  if (output.trim().length === 0) return { status: 'EMPTY_OUTPUT' };

  try {
    const parsed = JSON.parse(output) as {
      models?: Array<{ model_id?: unknown; model_name?: unknown; context_window_tokens?: unknown }>;
    };
    const models = Array.isArray(parsed.models)
      ? parsed.models.flatMap((model): EnumeratedModel[] => {
          if (typeof model.model_id !== 'string') return [];
          const maxInputTokens =
            typeof model.context_window_tokens === 'number' &&
            Number.isInteger(model.context_window_tokens) &&
            model.context_window_tokens > 0
              ? model.context_window_tokens
              : undefined;
          return [
            {
              value: model.model_id,
              label: typeof model.model_name === 'string' ? model.model_name : model.model_id,
              ...(maxInputTokens ? { maxInputTokens } : {}),
            },
          ];
        })
      : [];
    return parsedResult(output, models);
  } catch {
    return { status: 'FORMAT_MISMATCH' };
  }
};

export const parseOpenCodeVerboseModels = (output: string): ModelEnumerationResult => {
  const lines = output.split(/\r?\n/u);
  const models: EnumeratedModel[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim() ?? '';
    if (!/^[^\s{}]+\/[^\s{}]+$/u.test(value)) continue;

    const jsonLines: string[] = [];
    for (let jsonIndex = index + 1; jsonIndex < lines.length; jsonIndex += 1) {
      const line = lines[jsonIndex] ?? '';
      if (jsonLines.length === 0 && line.trim() !== '{') break;
      jsonLines.push(line);
      try {
        const metadata = JSON.parse(jsonLines.join('\n')) as { name?: unknown; limit?: { context?: unknown } };
        const context = metadata.limit?.context;
        models.push({
          value,
          label: typeof metadata.name === 'string' ? metadata.name : value,
          ...(typeof context === 'number' && Number.isInteger(context) && context > 0
            ? { maxInputTokens: context }
            : {}),
        });
        index = jsonIndex;
        break;
      } catch {
        // pretty-print JSON이 완성될 때까지 다음 줄을 이어 붙인다.
      }
    }
  }

  return parsedResult(output, models);
};

// 줄 단위 출력에서 "공백 없는 첫 토큰"만 요구하면 `Error` / `Unauthorized` / 한 단어 헤더 같은 진단 줄이
// 그대로 모델 값으로 통과한다. 러너별 실제 출력 형태로 좁힌다.
//  - 'tab':   `<id>\tLabel` (ANTIGRAVITY `agy models` 실측 형태)
//  - 'slash': `provider/model` (OpenCode `opencode models` 실측 형태)
type LineModelShape = 'tab' | 'slash';

export const parseLineModels = (output: string, shape: LineModelShape): ModelEnumerationResult =>
  parsedResult(
    output,
    output
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('Fetching '))
      .flatMap((line): EnumeratedModel[] => {
        if (shape === 'slash') {
          const value = line.trim();
          return /^[^\s{}]+\/[^\s{}]+$/u.test(value) ? [{ value, label: value }] : [];
        }

        const separatorIndex = line.indexOf('\t');
        if (separatorIndex < 0) return [];
        const value = line.slice(0, separatorIndex).trim();
        const label = line.slice(separatorIndex + 1).trim();
        return /^\S+$/u.test(value) ? [{ value, label: label || value }] : [];
      }),
  );

export const parseCursorModels = (output: string): ModelEnumerationResult =>
  parsedResult(
    output,
    output.split(/\r?\n/u).flatMap((line): EnumeratedModel[] => {
      const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/u);
      if (!match || match[1] === 'auto') return [];
      return [{ value: match[1] ?? '', label: match[2] ?? match[1] ?? '' }];
    }),
  );

/**
 * `grok models`는 JSON 플래그가 없고 사람이 읽는 평문만 낸다(2026-08-14 실측, grok 1.0.3):
 *
 *   You are logged in with grok.com.
 *
 *   Default model: grok-4.6
 *
 *   Available models:
 *     * grok-4.6 (default)
 *
 * `Available models:` 헤더 뒤의 글머리 줄만 읽는다. 헤더 앞줄에는 로그인 상태와
 * `Default model:` 같은 진단 문구가 섞여 있어, 줄 형태만으로 거르면 그것들이 모델 값으로
 * 새어 들어간다. 값 뒤의 `(default)` 표시는 값의 일부가 아니라 기본 모델 마커라 떼어낸다.
 */
export const parseGrokModels = (output: string): ModelEnumerationResult => {
  if (output.trim().length === 0) return { status: 'EMPTY_OUTPUT' };

  const lines = output.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => /^available models:\s*$/iu.test(line.trim()));
  if (headerIndex < 0) return { status: 'FORMAT_MISMATCH' };

  const models: EnumeratedModel[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = trimmed.match(/^[*\-•]\s+(\S+)(?:\s+\((.+)\))?$/u);
    // 글머리 형태가 아닌 줄이 나오면 목록 구획이 끝난 것으로 본다.
    if (!match) break;
    const value = match[1] ?? '';
    if (value.length > 0) models.push({ value, label: value });
  }

  return parsedResult(output, models);
};

const commandFailure = (error: unknown): ModelEnumerationResult => ({
  status: 'COMMAND_FAILED',
  message: error instanceof Error ? error.message : String(error),
});

export const enumerateModels = async (
  runnerType: RunnerType,
  dependencies: Partial<ModelEnumeratorDependencies> = {},
): Promise<ModelEnumerationResult> => {
  if (!RUNNER_CAPABILITIES[runnerType].modelEnumeration) {
    return { status: 'UNSUPPORTED' };
  }

  const deps = { ...defaultDependencies, ...dependencies };
  const isWindows = deps.platform() === 'win32';

  try {
    switch (runnerType) {
      case 'KIRO_CLI': {
        const executable = deps.resolveExecutable('kiro-cli', getKiroExecutablePreference(isWindows));
        return parseKiroModels((await deps.execute(executable, ['chat', '--list-models', '--format', 'json'])).stdout);
      }
      case 'OPENCODE': {
        const executable = deps.resolveExecutable('opencode', isWindows ? ['opencode.cmd', 'opencode'] : ['opencode']);
        try {
          const verbose = parseOpenCodeVerboseModels((await deps.execute(executable, ['models', '--verbose'])).stdout);
          if (verbose.status === 'SUCCESS') return verbose;
        } catch {
          // 구버전 또는 일시 오류에서는 안정적인 줄 단위 명령으로 한 번 폴백한다.
        }
        try {
          return parseLineModels((await deps.execute(executable, ['models'])).stdout, 'slash');
        } catch (error) {
          return commandFailure(error);
        }
      }
      case 'ANTIGRAVITY': {
        const executable = deps.resolveExecutable('agy', isWindows ? ['agy.cmd', 'agy'] : ['agy']);
        return parseLineModels((await deps.execute(executable, ['models'])).stdout, 'tab');
      }
      case 'CURSOR_CLI': {
        const executable = deps.resolveExecutable('agent', isWindows ? ['agent.cmd', 'agent'] : ['agent']);
        return parseCursorModels((await deps.execute(executable, ['models'])).stdout);
      }
      case 'GROK_BUILD': {
        const executable = deps.resolveExecutable('grok', getGrokExecutablePreference(isWindows));
        return parseGrokModels((await deps.execute(executable, ['models'])).stdout);
      }
      default:
        return { status: 'UNSUPPORTED' };
    }
  } catch (error) {
    return commandFailure(error);
  }
};
