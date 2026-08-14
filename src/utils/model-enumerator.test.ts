import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  enumerateModels,
  parseCursorModels,
  parseKiroModels,
  parseLineModels,
  parseOpenCodeVerboseModels,
  type ModelEnumeratorDependencies,
} from './model-enumerator.js';

const fixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../runners/fixtures/${name}`, import.meta.url)), 'utf8');

describe('model enumerator parsers', () => {
  test('parses OpenCode labels and context limits while allowing a missing context', async () => {
    const result = parseOpenCodeVerboseModels(await fixture('opencode-models-verbose.txt'));
    assert.deepEqual(result, {
      status: 'SUCCESS',
      values: [
        { value: 'opencode/big-pickle', label: 'Big Pickle', maxInputTokens: 200000 },
        { value: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
      ],
    });
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

  test('distinguishes empty output, format mismatch, and reserved values', () => {
    assert.deepEqual(parseLineModels('', 'tab'), { status: 'EMPTY_OUTPUT' });
    assert.deepEqual(parseCursorModels('Available models\ninvalid'), { status: 'FORMAT_MISMATCH' });
    assert.deepEqual(parseLineModels('__fast__:hidden\tHidden', 'tab'), { status: 'FORMAT_MISMATCH' });
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
      'CODEX',
      dependencies(async () => {
        called = true;
        return { stdout: '' };
      }),
    );
    assert.deepEqual(result, { status: 'UNSUPPORTED' });
    assert.equal(called, false);
  });
});
