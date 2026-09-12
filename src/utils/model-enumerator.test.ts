import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  enumerateModels,
  executeModelEnumerationCommand,
  parseCursorModels,
  parseGrokModels,
  parseKimiModels,
  parseKiroModels,
  parseOmpModels,
  parseLineModels,
  parseOpenCodeVerboseModels,
  sanitizeErrorOutput,
  type ModelEnumeratorDependencies,
} from './model-enumerator.js';

const fixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../runners/fixtures/${name}`, import.meta.url)), 'utf8');

type EnumeratedModelMeta = {
  value: string;
  label: string;
  maxInputTokens?: number;
  supportedEffortLevels?: string[];
  fastModeSupported?: boolean;
};

const asEnumeratedMeta = (model: { value: string; label: string; maxInputTokens?: number }): EnumeratedModelMeta =>
  model as EnumeratedModelMeta;

describe('model enumerator parsers', () => {
  // 픽스처는 `opencode models --verbose` 실출력에서 잘라 온 것이다(2026-09-06, opencode 1.18.18).
  // `variants: {}`(big-pickle), variants 키 자체가 없는 항목, 공급자별로 다른 조합
  // (muse-spark minimal-xhigh / deepseek low·high·max), effort 어휘 밖 이름(MiniMax-M3의 thinking)을
  // 모두 담고 있다.
  test('parses OpenCode labels, context limits, and per-model reasoning variants', async () => {
    const result = parseOpenCodeVerboseModels(await fixture('opencode-models-verbose.txt'));
    assert.deepEqual(result, {
      status: 'SUCCESS',
      values: [
        // variants가 빈 객체면 "이 모델은 강도 조절이 없다"가 아니라 "카탈로그에 없다"이므로 필드를 싣지 않는다.
        { value: 'opencode/big-pickle', label: 'Big Pickle', maxInputTokens: 200000 },
        // variants 키 자체가 없는 구버전/축약 항목도 그대로 통과해야 한다.
        { value: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
        {
          value: 'opencode/muse-spark-1.3-contributor-free',
          label: 'Muse Spark 1.3 Free',
          maxInputTokens: 1048576,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        },
        // 같은 카탈로그의 다른 공급자는 조합이 다르다. 한 모델의 조합을 다른 모델에 옮기면 이 단언이 깨진다.
        {
          value: 'openrouter/~deepseek/deepseek-v4-flash-latest',
          label: 'DeepSeek V4 Flash Latest',
          maxInputTokens: 1310720,
          supportedEffortLevels: ['low', 'high', 'max'],
        },
        // effort 어휘 밖 이름(`thinking`)도 daemon에서 지우지 않는다. 허용 어휘 판정은 API 한 곳에서 한다.
        {
          value: 'minimax/MiniMax-M3',
          label: 'MiniMax-M3',
          maxInputTokens: 1048576,
          supportedEffortLevels: ['none', 'thinking'],
        },
      ],
    });
  });

  test('ignores an OpenCode variants field that is not a keyed object', () => {
    const withArrayVariants = [
      'provider/model-a',
      '{',
      '  "name": "Model A",',
      '  "variants": ["low", "high"]',
      '}',
      'provider/model-b',
      '{',
      '  "name": "Model B",',
      '  "variants": null',
      '}',
    ].join('\n');

    assert.deepEqual(parseOpenCodeVerboseModels(withArrayVariants), {
      status: 'SUCCESS',
      values: [
        { value: 'provider/model-a', label: 'Model A' },
        { value: 'provider/model-b', label: 'Model B' },
      ],
    });
  });

  // 픽스처는 `omp models --json` 실출력에서 잘라 온 것이다(2026-08-25, omp/18.0.4).
  // provider 한정 selector, `~` 접두 id, `auto` 라우팅 sentinel, 그리고 공급자 3곳이
  // 같은 id(`openai/gpt-oss-120b`)를 쓰는 실제 충돌 케이스를 모두 담고 있다.
  test('parses omp models from real catalog output, keying on the provider-qualified selector', async () => {
    assert.deepEqual(parseOmpModels(await fixture('omp-models.json')), {
      status: 'SUCCESS',
      values: [
        {
          value: 'openrouter/~anthropic/claude-fable-latest',
          label: 'Claude Fable Latest (openrouter)',
          maxInputTokens: 1000000,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          value: 'groq/openai/gpt-oss-120b',
          label: 'GPT OSS 120B (groq)',
          maxInputTokens: 131072,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
        {
          value: 'openrouter/openai/gpt-oss-120b',
          label: 'gpt-oss-120b (openrouter)',
          maxInputTokens: 131072,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
        {
          value: 'together/openai/gpt-oss-120b',
          label: 'GPT OSS 120B (together)',
          maxInputTokens: 131072,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
        // reasoning: false + thinking: null → 레벨 없음. 엔진 전체 레벨을 대신 채우지 않는다.
        { value: 'openai/gpt-4o', label: 'GPT-4o (openai)', maxInputTokens: 128000 },
      ],
    });
  });

  // `reasoning` 불리언은 레벨 출처가 아니다. omp/18.1.2 실측 596건 중 `reasoning: true`인데
  // `thinking: null`인 항목이 3건 있다(예: xai-oauth/grok-4.20-0309-reasoning). 그런 항목에
  // 엔진 전체 레벨을 채우면 검증되지 않은 값을 지원으로 보고하게 된다.
  test('does not infer omp thinking levels from the reasoning boolean', () => {
    assert.deepEqual(
      parseOmpModels(
        JSON.stringify({
          models: [
            { provider: 'xai-oauth', id: 'grok-4.20-0309-reasoning', reasoning: true, thinking: null },
            { provider: 'local', id: 'llama-guess', reasoning: true },
            { provider: 'local', id: 'llama-bad-shape', reasoning: true, thinking: 'high' },
            { provider: 'local', id: 'llama-mixed', reasoning: true, thinking: ['  HIGH ', 'high', 42, ''] },
          ],
        }),
      ),
      {
        status: 'SUCCESS',
        values: [
          { value: 'grok-4.20-0309-reasoning', label: 'grok-4.20-0309-reasoning (xai-oauth)' },
          { value: 'llama-guess', label: 'llama-guess (local)' },
          { value: 'llama-bad-shape', label: 'llama-bad-shape (local)' },
          { value: 'llama-mixed', label: 'llama-mixed (local)', supportedEffortLevels: ['high'] },
        ],
      },
    );
  });

  test('parses omp JSON model metadata and ignores an empty available list', () => {
    // 공급자 키가 하나도 없으면 omp는 `{"models":[]}`를 낸다. 파싱은 됐지만 값이 0건이므로
    // EMPTY_OUTPUT이 아니라 FORMAT_MISMATCH다(빈 stdout과 구분된다).
    assert.deepEqual(parseOmpModels('{"models":[]}'), { status: 'FORMAT_MISMATCH' });
    // selector가 없는 항목은 id로 폴백하고, provider가 없으면 label에 접미사를 붙이지 않는다.
    assert.deepEqual(
      parseOmpModels(
        JSON.stringify({
          models: [
            { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000 },
            { id: 'local-model' },
          ],
        }),
      ),
      {
        status: 'SUCCESS',
        values: [
          { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', maxInputTokens: 200000 },
          { value: 'local-model', label: 'local-model' },
        ],
      },
    );
    assert.deepEqual(parseOmpModels('not-json'), { status: 'FORMAT_MISMATCH' });
    assert.deepEqual(parseOmpModels(''), { status: 'EMPTY_OUTPUT' });
  });

  test('parses Kiro model metadata', async () => {
    const result = parseKiroModels(await fixture('kiro-models.json'));
    assert.equal(result.status, 'SUCCESS');
    if (result.status !== 'SUCCESS') return;
    assert.deepEqual(result.values[1], {
      value: 'claude-sonnet-4.5',
      label: 'claude-sonnet-4.5',
      maxInputTokens: 200000,
    });
  });

  // 픽스처는 `kimi provider list --json` 실출력에서 가져온 것이다(2026-09-12, kimi 0.42.0).
  // `providers.<id>.apiKey`는 평문으로 나오므로 픽스처에는 더미 값 `"***"`만 둔다.
  // 파서는 `models` 맵만 읽고 `providers`를 어떤 경로로도 참조하지 않는다.
  test('parses Kimi models from the provider catalog map', async () => {
    const result = parseKimiModels(await fixture('kimi-models.json'));
    assert.equal(result.status, 'SUCCESS');
    if (result.status !== 'SUCCESS') return;
    assert.equal(result.values.length, 4);
    assert.deepEqual(result.values[1], {
      value: 'moonshot-ai/kimi-k3',
      label: 'kimi-k3 (moonshot-ai)',
      maxInputTokens: 1048576,
    });
    // 추론 강도(`supportEfforts`)는 이번 탐지에서 보고하지 않는다. KIMI_CLI의 effort
    // 판정이 false라 API가 레벨을 버리므로, 필드를 싣지 않고 "미확인"으로 남긴다.
    for (const model of result.values) {
      assert.equal(asEnumeratedMeta(model).supportedEffortLevels, undefined);
    }
  });

  test('classifies an empty Kimi catalog as EMPTY_OUTPUT and malformed output as FORMAT_MISMATCH', () => {
    // provider 키가 하나도 없으면 kimi는 빈 맵을 낸다. 성공이지만 보고할 모델이 없다.
    assert.deepEqual(parseKimiModels('{"providers":{},"models":{}}'), { status: 'EMPTY_OUTPUT' });
    assert.deepEqual(parseKimiModels(''), { status: 'EMPTY_OUTPUT' });
    assert.deepEqual(parseKimiModels('not json'), { status: 'FORMAT_MISMATCH' });
    // omp의 `{"models":[]}`와 달리 Kimi의 `models`는 맵이다. 배열이 오면 형식 불일치다.
    assert.deepEqual(parseKimiModels('{"models":[]}'), { status: 'FORMAT_MISMATCH' });
    // 키가 비었거나 model이 문자열이 아닌 항목은 건너뛴다.
    assert.deepEqual(
      parseKimiModels(JSON.stringify({ models: { '': { provider: 'x', model: 'y' }, 'p/broken': { provider: 'p' } } })),
      { status: 'FORMAT_MISMATCH' },
    );
  });

  test('parses Antigravity values without treating status text or labels as ids', async () => {
    assert.deepEqual(parseLineModels(await fixture('antigravity-models.txt'), 'tab'), {
      status: 'SUCCESS',
      values: [
        { value: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
        { value: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
      ],
    });
  });

  test('rejects diagnostic lines that carry no model shape', () => {
    // 인증 만료·네트워크 오류로 CLI가 한 단어 진단 메시지를 내면 그대로 승인 대기 목록에 쌓였다.
    assert.deepEqual(parseLineModels('Error\nUnauthorized\nhttps://example.com/login', 'tab'), {
      status: 'FORMAT_MISMATCH',
    });
    assert.deepEqual(parseLineModels('Error\nUnauthorized\nbare-token', 'slash'), { status: 'FORMAT_MISMATCH' });
    assert.deepEqual(parseLineModels('provider/model-a\nError', 'slash'), {
      status: 'SUCCESS',
      values: [{ value: 'provider/model-a', label: 'provider/model-a' }],
    });
  });

  test('drops values and labels that exceed the API length limit', () => {
    const longValue = 'a'.repeat(256);
    const longLabel = 'b'.repeat(300);
    assert.deepEqual(parseLineModels(`${longValue}\tlabel\nmodel-a\t${longLabel}`, 'tab'), {
      status: 'SUCCESS',
      values: [{ value: 'model-a', label: 'b'.repeat(255) }],
    });
  });

  test('drops Cursor headers, auto, and help text', async () => {
    assert.deepEqual(parseCursorModels(await fixture('cursor-models.txt')), {
      status: 'SUCCESS',
      values: [
        { value: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low' },
        { value: 'composer-2.5', label: 'Composer 2.5' },
      ],
    });
  });

  test('reads only the Grok bullet list under the Available models header', async () => {
    assert.deepEqual(parseGrokModels(await fixture('grok-models.txt')), {
      status: 'SUCCESS',
      values: [{ value: 'grok-4.6', label: 'grok-4.6' }],
    });
  });

  // 헤더 앞에는 로그인 상태와 `Default model:` 진단 줄이 있다. 줄 형태만으로 거르면
  // 그 값들이 모델로 새어 들어간다.
  test('does not leak Grok diagnostic lines above the header as models', () => {
    const output = ['You are logged in with grok.com.', '', 'Default model: grok-4.6', ''].join('\n');
    assert.deepEqual(parseGrokModels(output), { status: 'FORMAT_MISMATCH' });
  });

  test('stops the Grok list at the first non-bullet line and strips the default marker', () => {
    const output = ['Available models:', '  * grok-4.6 (default)', '  * grok-mini', '', 'Notes: something else'].join(
      '\n',
    );
    assert.deepEqual(parseGrokModels(output), {
      status: 'SUCCESS',
      values: [
        { value: 'grok-4.6', label: 'grok-4.6' },
        { value: 'grok-mini', label: 'grok-mini' },
      ],
    });
  });

  test('distinguishes empty output, format mismatch, and reserved values', () => {
    assert.deepEqual(parseLineModels('', 'tab'), { status: 'EMPTY_OUTPUT' });
    assert.deepEqual(parseCursorModels('Available models\ninvalid'), { status: 'FORMAT_MISMATCH' });
    assert.deepEqual(parseLineModels('__fast__:hidden\tHidden', 'tab'), { status: 'FORMAT_MISMATCH' });
    assert.deepEqual(parseGrokModels(''), { status: 'EMPTY_OUTPUT' });
  });
});

describe('enumerateModels', () => {
  const dependencies = (execute: ModelEnumeratorDependencies['execute']): Partial<ModelEnumeratorDependencies> => ({
    execute,
    platform: () => 'darwin',
    resolveExecutable: (name) => `/bin/${name}`,
  });

  test('falls back to line output when OpenCode verbose enumeration fails', async () => {
    const calls: string[][] = [];
    const result = await enumerateModels(
      'OPENCODE',
      dependencies(async (_executable, args) => {
        calls.push(args);
        if (args.includes('--verbose')) throw new Error('unsupported flag');
        return { stdout: 'provider/model-a\n' };
      }),
    );
    assert.deepEqual(calls, [['models', '--verbose'], ['models']]);
    assert.deepEqual(result, {
      status: 'SUCCESS',
      values: [{ value: 'provider/model-a', label: 'provider/model-a' }],
    });
  });

  // 엔진 탐지(engine-commands.ts)와 러너 기동(opencode.ts)은 config.runnerCmd를 따르는데
  // 열거만 'opencode'를 하드코딩하면, RUNNER_CMD를 바꾼 환경에서 탐지는 되고 열거만 실패한다.
  test('enumerates OpenCode with the configured runner command', async () => {
    const requestedNames: string[] = [];
    const result = await enumerateModels(
      'OPENCODE',
      {
        execute: async () => ({ stdout: 'provider/model-a\n' }),
        platform: () => 'darwin',
        resolveExecutable: (name) => {
          requestedNames.push(name);
          return `/bin/${name}`;
        },
      },
      'custom-opencode',
    );

    assert.deepEqual(requestedNames, ['custom-opencode']);
    assert.equal(result.status, 'SUCCESS');
  });

  // 인자를 주지 않는 기존 호출부는 그대로 'opencode'를 해석해야 한다.
  test('falls back to the default OpenCode command when none is provided', async () => {
    const requestedNames: string[] = [];
    await enumerateModels('OPENCODE', {
      execute: async () => ({ stdout: 'provider/model-a\n' }),
      platform: () => 'darwin',
      resolveExecutable: (name) => {
        requestedNames.push(name);
        return `/bin/${name}`;
      },
    });

    assert.deepEqual(requestedNames, ['opencode']);
  });

  test('classifies command failures instead of throwing', async () => {
    const result = await enumerateModels(
      'KIRO_CLI',
      dependencies(async () => {
        throw new Error('offline');
      }),
    );
    assert.equal(result.status, 'COMMAND_FAILED');
  });

  test('does not enumerate unsupported runners', async () => {
    let called = false;
    const result = await enumerateModels(
      'CLAUDE_CODE',
      dependencies(async () => {
        called = true;
        return { stdout: '' };
      }),
    );
    assert.deepEqual(result, { status: 'UNSUPPORTED' });
    assert.equal(called, false);
  });

  test('enumerates Codex models from debug catalog JSON with effort and fastMode metadata', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const result = await enumerateModels(
      'CODEX',
      dependencies(async (executable, args) => {
        calls.push({ executable, args });
        return { stdout: await fixture('codex-debug-models.json') };
      }),
    );

    assert.deepEqual(calls, [{ executable: '/bin/codex', args: ['debug', 'models'] }]);
    assert.equal(result.status, 'SUCCESS');
    if (result.status !== 'SUCCESS') return;

    const sol = result.values.find((model) => model.value === 'gpt-5.6-sol');
    const luna = result.values.find((model) => model.value === 'gpt-5.6-luna');
    assert.ok(sol, 'visible catalog models must be present');
    assert.ok(luna, 'visible catalog models must be present');
    assert.equal(sol.label, 'GPT-5.6-Sol');
    assert.equal(sol.maxInputTokens, 272000);
    assert.deepEqual(asEnumeratedMeta(sol).supportedEffortLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(asEnumeratedMeta(sol).fastModeSupported, true);
    assert.equal(luna.label, 'GPT-5.6-Luna');
    assert.deepEqual(asEnumeratedMeta(luna).supportedEffortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(asEnumeratedMeta(luna).fastModeSupported, true);

    // 같은 카탈로그 안에서 ultra까지 / max까지 / xhigh까지가 모두 갈린다. 셋을 함께 단언해야
    // "카탈로그를 읽는 대신 엔진 전체 레벨을 채우는" 회귀가 잡힌다(codex-cli 0.153.2 실측과 동일).
    const spark = result.values.find((model) => model.value === 'gpt-5.3-codex-spark');
    assert.ok(spark, 'visible catalog models must be present');
    assert.deepEqual(asEnumeratedMeta(spark).supportedEffortLevels, ['low', 'medium', 'high', 'xhigh']);
  });

  test('excludes hidden Codex entries while retaining CLI-runnable entries unsupported by the platform API', async () => {
    const result = await enumerateModels(
      'CODEX',
      dependencies(async () => ({ stdout: await fixture('codex-debug-models.json') })),
    );

    assert.equal(result.status, 'SUCCESS');
    if (result.status !== 'SUCCESS') return;

    const values = result.values.map((model) => model.value);
    assert.ok(values.includes('gpt-5.6-sol'));
    assert.ok(values.includes('gpt-5.6-luna'));
    assert.ok(!values.includes('gpt-reserve'), 'visibility: hide entries must not be reported');
    assert.ok(values.includes('gpt-5.3-codex-spark'), 'supported_in_api: false still allows Codex CLI execution');
  });

  test('classifies non-JSON or models-key-missing Codex output as FORMAT_MISMATCH without throwing', async () => {
    const notJson = await enumerateModels(
      'CODEX',
      dependencies(async () => ({ stdout: 'Available models:\n- gpt-5.2\n' })),
    );
    assert.equal(notJson.status, 'FORMAT_MISMATCH');

    const missingModelsKey = await enumerateModels(
      'CODEX',
      dependencies(async () => ({ stdout: JSON.stringify({ catalog: [] }) })),
    );
    assert.equal(missingModelsKey.status, 'FORMAT_MISMATCH');
  });

  test('classifies Codex enumeration command failures instead of throwing', async () => {
    const result = await enumerateModels(
      'CODEX',
      dependencies(async () => {
        throw new Error('codex debug models failed');
      }),
    );
    assert.equal(result.status, 'COMMAND_FAILED');
  });

  test('enumerates OMP models from JSON output', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const result = await enumerateModels('OMP', {
      ...dependencies(async (executable, args) => {
        calls.push({ executable, args });
        return {
          stdout: JSON.stringify({
            models: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000 }],
          }),
        };
      }),
      findOmp: async () => '/bin/omp',
    });
    assert.deepEqual(calls, [{ executable: '/bin/omp', args: ['models', '--json'] }]);
    assert.deepEqual(result, {
      status: 'SUCCESS',
      values: [{ value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', maxInputTokens: 200000 }],
    });
  });

  test('enumerates Kimi models from the provider list command', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const result = await enumerateModels(
      'KIMI_CLI',
      dependencies(async (executable, args) => {
        calls.push({ executable, args });
        return { stdout: await fixture('kimi-models.json') };
      }),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['provider', 'list', '--json']);
    assert.equal(result.status, 'SUCCESS');
    if (result.status !== 'SUCCESS') return;
    assert.deepEqual(
      result.values.map((model) => model.value),
      [
        'moonshot-ai/kimi-k2.6',
        'moonshot-ai/kimi-k3',
        'moonshot-ai/kimi-k2.7-code-highspeed',
        'moonshot-ai/kimi-k2.7-code',
      ],
    );
  });

  test('enumerates ANTIGRAVITY models with tab parser', async () => {
    const calls: string[][] = [];
    const result = await enumerateModels(
      'ANTIGRAVITY',
      dependencies(async (_executable, args) => {
        calls.push(args);
        return { stdout: 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n' };
      }),
    );
    assert.deepEqual(calls, [['models']]);
    assert.deepEqual(result, {
      status: 'SUCCESS',
      values: [{ value: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' }],
    });
  });

  test('uses the engine command SSOT for Windows executable preferences', async () => {
    const preferences = new Map<string, string[]>();
    const deps: Partial<ModelEnumeratorDependencies> = {
      execute: async () => ({ stdout: 'model-a\n' }),
      platform: () => 'win32',
      resolveExecutable: (name, preferredNames) => {
        preferences.set(name, preferredNames);
        return `C:\\bin\\${name}`;
      },
      findCursorCli: async (preferredNames) => {
        preferences.set('agent', preferredNames);
        return 'C:\\bin\\agent';
      },
      findGrokBuild: async (preferredNames) => {
        preferences.set('grok', preferredNames);
        return 'C:\\bin\\grok.exe';
      },
      findOmp: async (preferredNames) => {
        preferences.set('omp', preferredNames);
        return 'C:\\bin\\omp.exe';
      },
    };

    await enumerateModels('CURSOR_CLI', deps);
    await enumerateModels('ANTIGRAVITY', deps);
    await enumerateModels('GROK_BUILD', deps);
    await enumerateModels('OMP', deps);

    assert.deepEqual(preferences.get('agent'), ['cursor-agent', 'agent']);
    assert.deepEqual(preferences.get('agy'), ['agy.cmd', 'agy']);
    assert.deepEqual(preferences.get('grok'), ['grok.exe', 'grok']);
    assert.deepEqual(preferences.get('omp'), ['omp.exe', 'omp']);
  });

  // 러너 기동과 같은 신원 확인을 거치므로, `agent`가 다른 도구면 그 도구의 모델 목록을 읽지 않는다.
  test('Cursor enumeration runs only an executable that passed the identity check', async () => {
    const executed: string[] = [];
    const deps: Partial<ModelEnumeratorDependencies> = {
      execute: async (executable) => {
        executed.push(executable);
        return { stdout: 'composer-2 - Composer 2\n' };
      },
      platform: () => 'linux',
      resolveExecutable: () => '/home/me/.grok/bin/agent',
    };

    const missing = await enumerateModels('CURSOR_CLI', { ...deps, findCursorCli: async () => null });
    assert.equal(missing.status, 'COMMAND_FAILED');
    assert.deepEqual(executed, []);

    const found = await enumerateModels('CURSOR_CLI', {
      ...deps,
      findCursorCli: async () => '/home/me/.local/bin/cursor-agent',
    });
    assert.equal(found.status, 'SUCCESS');
    assert.deepEqual(executed, ['/home/me/.local/bin/cursor-agent']);
  });

  // 러너 기동과 같은 신원 확인을 거치므로, `grok`이 다른 도구면 그 도구의 모델 목록을 읽지 않는다.
  test('Grok Build enumeration runs only an executable that passed the identity check', async () => {
    const executed: string[] = [];
    const deps: Partial<ModelEnumeratorDependencies> = {
      execute: async (executable) => {
        executed.push(executable);
        return { stdout: 'Available models:\n  * grok-4.6 (default)\n' };
      },
      platform: () => 'linux',
      resolveExecutable: () => '/usr/bin/grok',
    };

    const missing = await enumerateModels('GROK_BUILD', { ...deps, findGrokBuild: async () => null });
    assert.equal(missing.status, 'COMMAND_FAILED');
    assert.deepEqual(executed, []);

    const found = await enumerateModels('GROK_BUILD', {
      ...deps,
      findGrokBuild: async () => '/home/me/.local/bin/grok',
    });
    assert.equal(found.status, 'SUCCESS');
    assert.deepEqual(executed, ['/home/me/.local/bin/grok']);
  });

  // 러너 기동과 같은 신원 확인을 거치므로, `omp`가 무관한 동명 패키지면 그 도구의 모델 목록을 읽지 않는다.
  test('OMP enumeration runs only an executable that passed the identity check', async () => {
    const executed: string[] = [];
    const deps: Partial<ModelEnumeratorDependencies> = {
      execute: async (executable) => {
        executed.push(executable);
        return {
          stdout: JSON.stringify({
            models: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000 }],
          }),
        };
      },
      platform: () => 'linux',
      resolveExecutable: () => '/usr/lib/node_modules/omp',
    };

    const missing = await enumerateModels('OMP', { ...deps, findOmp: async () => null });
    assert.equal(missing.status, 'COMMAND_FAILED');
    assert.deepEqual(executed, []);

    const found = await enumerateModels('OMP', {
      ...deps,
      findOmp: async () => '/home/me/.local/bin/omp',
    });
    assert.equal(found.status, 'SUCCESS');
    assert.deepEqual(executed, ['/home/me/.local/bin/omp']);
  });
});

describe('sanitizeErrorOutput', () => {
  test('redacts sensitive credentials and JWTs from error output', () => {
    const raw =
      'Error: Bearer secret-token-123 failed with api_key: key-456 cookie: sess=abc eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.xyz';
    const sanitized = sanitizeErrorOutput(raw);
    assert.equal(
      sanitized,
      'Error: Bearer [REDACTED] failed with api_key: [REDACTED] cookie: [REDACTED] [REDACTED_JWT]',
    );
  });

  test('truncates error output exceeding max length', () => {
    const longString = 'x'.repeat(600);
    const sanitized = sanitizeErrorOutput(longString);
    assert.equal(sanitized.length, 503);
    assert.ok(sanitized.endsWith('...'));
  });

  test('returns empty string for blank input', () => {
    assert.equal(sanitizeErrorOutput(''), '');
    assert.equal(sanitizeErrorOutput('   \n  '), '');
  });
});

describe('executeModelEnumerationCommand', () => {
  test('executes command with ignored stdin so process does not hang on stdin', async () => {
    const res = await executeModelEnumerationCommand(process.execPath, [
      '-e',
      "let receivedData = false; process.stdin.on('data', () => { receivedData = true; }); process.stdin.on('end', () => { console.log(receivedData ? 'data' : 'no-data-eof'); }); process.stdin.resume();",
    ]);
    assert.equal(res.stdout.trim(), 'no-data-eof');
  });

  test('captures and sanitizes stderr on non-zero exit code', async () => {
    await assert.rejects(
      async () => {
        await executeModelEnumerationCommand(process.execPath, [
          '-e',
          "console.error('fatal error: Bearer secret-token-abc'); process.exit(1);",
        ]);
      },
      (err: Error) => {
        assert.ok(err.message.includes('Command failed (exit code 1)'));
        assert.ok(err.message.includes('Bearer [REDACTED]'));
        assert.ok(!err.message.includes('secret-token-abc'));
        return true;
      },
    );
  });

  test('enforces timeout and kills hanging processes', async () => {
    await assert.rejects(
      async () => {
        await executeModelEnumerationCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
          timeoutMs: 100,
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes('Command timed out after 100ms'));
        return true;
      },
    );
  });

  test('enforces stdout maxBuffer limit', async () => {
    await assert.rejects(
      async () => {
        await executeModelEnumerationCommand(process.execPath, ['-e', "console.log('x'.repeat(1000));"], {
          maxBufferBytes: 100,
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes('stdout maxBuffer exceeded'));
        return true;
      },
    );
  });

  test('spawns powershell.exe with -Command launcher on win32', async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const mockSpawn = ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => true;
      setImmediate(() => {
        stdout.end('provider/model-1\n');
        stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const res = await executeModelEnumerationCommand('C:\\tools\\opencode.cmd', ['models'], {
      platform: () => 'win32',
      spawn: mockSpawn,
    });

    assert.equal(res.stdout, 'provider/model-1\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'powershell.exe');
    assert.deepEqual(calls[0]?.args, [
      '-NoLogo',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "& 'C:\\tools\\opencode.cmd' 'models'",
    ]);
  });

  test('spawns executable directly on non-win32', async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const mockSpawn = ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => true;
      setImmediate(() => {
        stdout.end('provider/model-1\n');
        stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const res = await executeModelEnumerationCommand('/usr/local/bin/opencode', ['models'], {
      platform: () => 'darwin',
      spawn: mockSpawn,
    });

    assert.equal(res.stdout, 'provider/model-1\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, '/usr/local/bin/opencode');
    assert.deepEqual(calls[0]?.args, ['models']);
  });

  test('executes real .cmd file on Windows platform', { skip: process.platform !== 'win32' }, async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'enum-cmd-test-'));
    const cmdPath = join(tempDir, 'fake-models.cmd');
    await writeFile(cmdPath, '@echo off\r\necho test/model-1\r\necho test/model-2\r\n', 'utf8');

    try {
      const res = await executeModelEnumerationCommand(cmdPath, []);
      assert.ok(res.stdout.includes('test/model-1'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
