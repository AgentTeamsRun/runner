import { executeMuseCodeModelList } from './muse-code-models.js';
import { findMuseCodeExecutable } from '../runners/muse-code-identity.js';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { RunnerType } from '@agentteams/core-constants';
import { buildPowerShellCommand, resolveExecutablePathWithPreference } from '../executable.js';
import { sanitizeAntigravityInternalLogLine } from '../runners/antigravity.js';
import { RUNNER_CAPABILITIES } from '../runners/capabilities.js';
import { getEngineCommand, getEngineExecutablePreference } from '../runners/engine-commands.js';

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
  supportedEffortLevels?: string[];
  fastModeSupported?: boolean;
};

export type ModelEnumerationResult =
  | { status: 'SUCCESS'; values: EnumeratedModel[] }
  | { status: 'UNSUPPORTED' | 'EMPTY_OUTPUT' | 'FORMAT_MISMATCH' | 'COMMAND_FAILED'; message?: string };

export type ModelEnumeratorDependencies = {
  executeMuseCode?: typeof executeMuseCodeModelList;
  findMuseCode?: typeof findMuseCodeExecutable;
  execute: (executablePath: string, args: string[]) => Promise<{ stdout: string }>;
  platform: () => NodeJS.Platform;
  resolveExecutable: (name: string, preferredNames: string[]) => string;
};

export type ExecuteModelEnumerationOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
  platform?: () => NodeJS.Platform;
  spawn?: typeof spawn;
};

export const executeModelEnumerationCommand = (
  executablePath: string,
  args: string[],
  options: ExecuteModelEnumerationOptions = {},
): Promise<{ stdout: string }> => {
  const timeoutMs = options.timeoutMs ?? ENUMERATION_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? 10 * 1024 * 1024;
  const spawnFn = options.spawn ?? spawn;
  const os = (options.platform ?? platform)();

  return new Promise((resolve, reject) => {
    const child =
      os === 'win32'
        ? spawnFn(
            'powershell.exe',
            [
              '-NoLogo',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              buildPowerShellCommand(executablePath, args),
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            },
          )
        : spawnFn(executablePath, args, {
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

/**
 * `omp models --json` (2026-08-25 실측, omp/18.0.4). 항목 형태:
 *
 *   {"provider":"openrouter","id":"~anthropic/claude-fable-latest",
 *    "selector":"openrouter/~anthropic/claude-fable-latest","name":"Claude Fable Latest",
 *    "contextWindow":1000000, ...}
 *
 * **카탈로그는 공급자 자격 증명이 하나라도 있을 때만 나온다.** 키가 전혀 없으면
 * `{"models":[]}`(+ 평문 모드에서는 `No models available. Set API keys in environment
 * variables.`)이고, `OPENROUTER_API_KEY`를 아무 문자열로나 넣으면 openrouter 공개
 * 카탈로그 470건이 즉시 나온다(키 유효성은 검증하지 않는다). 즉 목록에 있다고 실제로
 * 호출 가능한 것은 아니다. 실행 가능 여부는 트리거가 실패해야 드러난다.
 *
 * `value`로는 `id`가 아니라 provider 한정 `selector`를 쓴다. `id`는 공급자 간 충돌한다
 * (실측: 11개 공급자 키를 넣으면 750건 중 10개 id가 2~3개 공급자에 중복 —
 * `openai/gpt-oss-120b`가 groq·openrouter·together 셋). `id`를 value로 쓰면
 * `normalizeModels`의 중복 제거가 뒤쪽 공급자를 경고 없이 버린다. `--model`은 selector
 * 형태를 그대로 수용한다(실측: `--model mock/mock-model`로 모델 해석 통과).
 *
 * `id: "auto"`(openrouter 자동 라우팅 sentinel)는 `parseCursorModels`의 `auto`와 같은
 * 이유로 제외한다 — 실제 모델이 아니라 어떤 모델이 쓰였는지 추적할 수 없다.
 *
 * stdout만 파싱한다(Node NO_COLOR 경고는 stderr).
 */
export const parseOmpModels = (output: string): ModelEnumerationResult => {
  if (output.trim().length === 0) return { status: 'EMPTY_OUTPUT' };

  try {
    const parsed = JSON.parse(output) as {
      models?: Array<{ provider?: unknown; id?: unknown; selector?: unknown; name?: unknown; contextWindow?: unknown }>;
    };
    const models = Array.isArray(parsed.models)
      ? parsed.models.flatMap((model): EnumeratedModel[] => {
          if (typeof model.id !== 'string' || model.id.trim().length === 0) return [];
          if (model.id.trim() === 'auto') return [];
          const selector = typeof model.selector === 'string' ? model.selector.trim() : '';
          const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
          const name = typeof model.name === 'string' ? model.name.trim() : '';
          const maxInputTokens =
            typeof model.contextWindow === 'number' && Number.isInteger(model.contextWindow) && model.contextWindow > 0
              ? model.contextWindow
              : undefined;
          const value = selector.length > 0 ? selector : model.id;
          const baseLabel = name.length > 0 ? name : model.id;
          return [
            {
              value,
              label: provider.length > 0 ? `${baseLabel} (${provider})` : baseLabel,
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

/**
 * `codex debug models` (2026-09-03 실측, codex-cli 0.152.0)의 JSON 카탈로그를 읽는다.
 * `visibility: "hide"`는 Codex CLI의 모델 목록에서 숨긴 항목이므로 사용자 선택 목록에서도 제외한다.
 * `supported_in_api`는 OpenAI 플랫폼 API 가용성 축이며 ChatGPT 계정으로 실행하는 Codex CLI 가용성과
 * 다르다. 실측상 false인 gpt-5.3-codex-spark도 CLI에서 실행되므로 이 필드로 거르지 않는다.
 *
 * `context_window`는 현재 기본 실행 한도이고 `max_context_window`는 확장 가능한 상한이다.
 * 실출력에서 gpt-5.6-sol이 각각 272000/872000으로 달라 기본 한도를 우선하며, 구버전 호환을
 * 위해 `context_window`가 없을 때만 `max_context_window`로 폴백한다.
 * 필요한 필드만 새 객체로 옮겨 `model_messages.instructions_template` 같은 원문은 보존하지 않는다.
 */
export const parseCodexModels = (output: string): ModelEnumerationResult => {
  if (output.trim().length === 0) return { status: 'EMPTY_OUTPUT' };

  try {
    const parsed = JSON.parse(output) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
        supported_in_api?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
        additional_speed_tiers?: unknown;
        context_window?: unknown;
        max_context_window?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.models)) return { status: 'FORMAT_MISMATCH' };

    const models = parsed.models.flatMap((model): EnumeratedModel[] => {
      if (typeof model.slug !== 'string') return [];
      if (model.visibility === 'hide') return [];

      const supportedEffortLevels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.flatMap(({ effort }) =>
            typeof effort === 'string' && effort.trim().length > 0 ? [effort.trim()] : [],
          )
        : [];
      const maxInputTokensCandidate =
        typeof model.context_window === 'number' ? model.context_window : model.max_context_window;
      const maxInputTokens =
        typeof maxInputTokensCandidate === 'number' &&
        Number.isInteger(maxInputTokensCandidate) &&
        maxInputTokensCandidate > 0
          ? maxInputTokensCandidate
          : undefined;

      return [
        {
          value: model.slug,
          label: typeof model.display_name === 'string' ? model.display_name : model.slug,
          ...(maxInputTokens ? { maxInputTokens } : {}),
          ...(supportedEffortLevels.length > 0 ? { supportedEffortLevels } : {}),
          fastModeSupported:
            Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes('fast'),
        },
      ];
    });
    return parsedResult(output, models);
  } catch {
    return { status: 'FORMAT_MISMATCH' };
  }
};

// muse schema generate-ts (1.0.2): ModelListResult.models의 필드를 검증한다.
export const parseMuseCodeModels = (output: string): ModelEnumerationResult => {
  if (!output.trim()) return { status: 'EMPTY_OUTPUT' };
  try {
    const result = JSON.parse(output) as { models?: unknown };
    if (!Array.isArray(result.models)) return { status: 'FORMAT_MISMATCH' };
    if (result.models.length === 0) return { status: 'EMPTY_OUTPUT' };
    const models: EnumeratedModel[] = [];
    for (const row of result.models) {
      if (!row || typeof row !== 'object' || typeof row.modelId !== 'string' || typeof row.displayLabel !== 'string')
        return { status: 'FORMAT_MISMATCH' };
      models.push({
        value: row.modelId,
        label: row.isDefault === true ? `${row.displayLabel} (default)` : row.displayLabel,
        ...(typeof row.contextLimit === 'number' && Number.isInteger(row.contextLimit) && row.contextLimit > 0
          ? { maxInputTokens: row.contextLimit }
          : {}),
      });
    }
    return parsedResult(output, models);
  } catch {
    return { status: 'FORMAT_MISMATCH' };
  }
};

const commandFailure = (error: unknown): ModelEnumerationResult => ({
  status: 'COMMAND_FAILED',
  message: error instanceof Error ? error.message : String(error),
});

/// OPENCODE 실행 파일 이름의 기본값. `config.ts`의 `DEFAULT_RUNNER_CMD`와 같은 값이며,
/// 인자를 주지 않는 기존 호출부의 동작을 유지하기 위한 폴백이다.
const DEFAULT_OPENCODE_COMMAND = 'opencode';

export const enumerateModels = async (
  runnerType: RunnerType,
  dependencies: Partial<ModelEnumeratorDependencies> = {},
  /// OPENCODE 실행 파일 이름(`config.runnerCmd`). 엔진 탐지·러너 기동과 같은 이름을 봐야
  /// RUNNER_CMD를 바꾼 환경에서 "탐지는 되는데 열거만 실패하는" 어긋남이 생기지 않는다.
  opencodeCommand: string = DEFAULT_OPENCODE_COMMAND,
): Promise<ModelEnumerationResult> => {
  if (!RUNNER_CAPABILITIES[runnerType].modelEnumeration) {
    return { status: 'UNSUPPORTED' };
  }

  const deps = { ...defaultDependencies, ...dependencies };
  const isWindows = deps.platform() === 'win32';

  try {
    const resolveEngineExecutable = (type: RunnerType): string => {
      const command = getEngineCommand(type, opencodeCommand);
      return deps.resolveExecutable(command, getEngineExecutablePreference(type, opencodeCommand, isWindows));
    };

    switch (runnerType) {
      case 'MUSE_CODE': {
        const executable = await (deps.findMuseCode ?? findMuseCodeExecutable)(
          getEngineExecutablePreference(runnerType, opencodeCommand, isWindows),
          { platform: deps.platform },
        );
        if (!executable) return { status: 'COMMAND_FAILED', message: 'Cannot find an official Muse Code executable' };
        return parseMuseCodeModels(
          (await (deps.executeMuseCode ?? executeMuseCodeModelList)(executable, { platform: deps.platform })).stdout,
        );
      }
      case 'CODEX': {
        const executable = resolveEngineExecutable(runnerType);
        return parseCodexModels((await deps.execute(executable, ['debug', 'models'])).stdout);
      }
      case 'KIRO_CLI': {
        const executable = resolveEngineExecutable(runnerType);
        return parseKiroModels((await deps.execute(executable, ['chat', '--list-models', '--format', 'json'])).stdout);
      }
      case 'OPENCODE': {
        const executable = resolveEngineExecutable(runnerType);
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
        const executable = resolveEngineExecutable(runnerType);
        return parseLineModels((await deps.execute(executable, ['models'])).stdout, 'tab');
      }
      case 'CURSOR_CLI': {
        const executable = resolveEngineExecutable(runnerType);
        return parseCursorModels((await deps.execute(executable, ['models'])).stdout);
      }
      case 'GROK_BUILD': {
        const executable = resolveEngineExecutable(runnerType);
        return parseGrokModels((await deps.execute(executable, ['models'])).stdout);
      }
      case 'OMP': {
        const executable = resolveEngineExecutable(runnerType);
        return parseOmpModels((await deps.execute(executable, ['models', '--json'])).stdout);
      }
      default:
        return { status: 'UNSUPPORTED' };
    }
  } catch (error) {
    return commandFailure(error);
  }
};
