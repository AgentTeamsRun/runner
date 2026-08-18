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
  parseKiroModels,
  parseLineModels,
  parseOpenCodeVerboseModels,
  sanitizeErrorOutput,
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
