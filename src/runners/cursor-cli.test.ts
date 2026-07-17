import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractResultTextFromStreamJson } from './claude-code.js';
import { buildCursorCliArgs, CursorCliRunner, toCursorPowerShellEncodedCommand } from './cursor-cli.js';
import type { RunnerOptions } from './types.js';

test('buildCursorCliArgs fixes unattended stream-json flags and keeps the prompt last', () => {
  assert.deepEqual(buildCursorCliArgs('hello', 'composer-2'), [
    '-p',
    '--force',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--model',
    'composer-2',
    'hello',
  ]);
});

test('buildCursorCliArgs omits --model for default, blank, null, and undefined values', () => {
  for (const model of ['default', '   ', null, undefined]) {
    const args = buildCursorCliArgs('hello', model);
    assert.equal(args.includes('--model'), false);
    assert.equal(args.at(-1), 'hello');
  }
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

test('toCursorPowerShellEncodedCommand reads a UTF-8 prompt file and preserves argument order', () => {
  const script = decodePowerShellCommand(
    toCursorPowerShellEncodedCommand(
      'C:/Cursor/agent.exe',
      'C:/repo/.agentteams/runner/tmp/trigger.prompt.txt',
      'gpt-5',
    ),
  );
  assert.match(script, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(
    script,
    /'-p' '--force' '--output-format' 'stream-json' '--stream-partial-output' '--model' 'gpt-5' \$promptText/u,
  );
});

test('toCursorPowerShellEncodedCommand does not embed the prompt or pass a default model', () => {
  const prompt = "한글 ' 특수문자\r\n'@\r\n" + '긴 프롬프트'.repeat(10_000);
  const script = decodePowerShellCommand(
    toCursorPowerShellEncodedCommand('C:/Cursor/agent.cmd', 'C:/repo/prompt.txt', 'default'),
  );
  assert.equal(script.includes(prompt), false);
  assert.equal(script.includes('--model'), false);
});

type FakeChild = EventEmitter & {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
};

const createFakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

const baseOptions = (overrides: Partial<RunnerOptions> = {}): RunnerOptions => ({
  triggerId: 'trigger-123',
  prompt: '프롬프트 with special chars \' " $()\n' + '긴 내용'.repeat(2_000),
  authPath: '/repo',
  apiKey: 'agentteams-key',
  apiUrl: 'https://api.example.com',
  teamId: 'team-id',
  projectId: 'project-id',
  timeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  agentConfigId: 'agent-id',
  model: 'default',
  ...overrides,
});

type HarnessOptions = {
  os: NodeJS.Platform;
  executablePath?: string;
  onSpawn?: (child: FakeChild) => void;
};

const createHarness = ({ os, executablePath, onSpawn }: HarnessOptions) => {
  const child = createFakeChild();
  const calls = {
    spawned: [] as Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>,
    writes: [] as Array<{ path: string; content: string; encoding: string | undefined }>,
    removed: [] as string[],
    terminations: [] as Array<{ isWindows: boolean; reason: string }>,
  };
  const runner = new CursorCliRunner({
    platform: () => os,
    resolveExecutablePath: (() =>
      executablePath ?? (os === 'win32' ? 'C:/Cursor/agent.exe' : '/usr/local/bin/agent')) as never,
    describeExecutableResolution: (() => ({
      requestedCommand: 'agent',
      resolvedExecutablePath: executablePath ?? '/usr/local/bin/agent',
      platform: os,
      shell: false,
    })) as never,
    mkdir: (async () => undefined) as never,
    writeFile: (async (path: string, content: string, options?: { encoding?: string }) => {
      calls.writes.push({ path, content, encoding: options?.encoding });
    }) as never,
    rm: (async (path: string) => {
      calls.removed.push(path);
    }) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel: () => {} })) as never,
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.spawned.push({ command, args, options });
      queueMicrotask(() => onSpawn?.(child));
      return child;
    }) as never,
    terminateRunnerChild: ((_child: FakeChild, isWindows: boolean, _triggerId: string, reason: string) => {
      calls.terminations.push({ isWindows, reason });
      queueMicrotask(() => child.emit('close', null));
    }) as never,
  });
  return { child, calls, runner };
};

for (const executablePath of ['C:/Cursor/agent.exe', 'C:/Users/test/AppData/Local/Cursor/agent.cmd']) {
  test(`Windows runner preserves UTF-8 prompt and cleans it after success (${executablePath.split('/').at(-1)})`, async () => {
    const { child, calls, runner } = createHarness({
      os: 'win32',
      executablePath,
      onSpawn: (spawnedChild) => {
        spawnedChild.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } })}\n`,
          ),
        );
        spawnedChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ type: 'result', result: 'Final answer' })}\n`),
        );
        spawnedChild.emit('close', 0);
      },
    });
    const logs: string[] = [];
    const options = baseOptions({ onStdoutChunk: (message) => logs.push(message) });
    const result = await runner.run(options);

    assert.equal(result.exitCode, 0);
    assert.equal(extractResultTextFromStreamJson(result.outputText ?? ''), 'Final answer');
    assert.deepEqual(logs, ['Working.', '[Result] Completed']);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.writes[0]?.content, options.prompt);
    assert.equal(calls.writes[0]?.encoding, 'utf8');
    assert.deepEqual(calls.removed, ['/repo/.agentteams/runner/tmp/trigger-123.prompt.txt']);
    assert.equal(calls.spawned[0]?.command, 'powershell.exe');
    assert.equal(calls.spawned[0]?.options.windowsHide, true);
    assert.equal(calls.spawned[0]?.options.shell, false);
    assert.equal(child.listenerCount('close') > 0, true);
  });
}

test('Unix runner launches the resolved agent directly with shell=false and a detached process group', async () => {
  const { calls, runner } = createHarness({
    os: 'linux',
    onSpawn: (child) => child.emit('close', 0),
  });
  const result = await runner.run(baseOptions({ prompt: 'hello', model: 'composer-2' }));
  assert.equal(result.exitCode, 0);
  assert.equal(calls.spawned[0]?.command, '/usr/local/bin/agent');
  assert.deepEqual(calls.spawned[0]?.args, buildCursorCliArgs('hello', 'composer-2'));
  assert.equal(calls.spawned[0]?.options.shell, false);
  assert.equal(calls.spawned[0]?.options.detached, true);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.removed.length, 0);
});

test('runner preserves a terminal result after the head-capped output buffer is full', async () => {
  const { runner } = createHarness({
    os: 'linux',
    onSpawn: (child) => {
      child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'other', padding: 'x'.repeat(210_000) })}\n`),
      );
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: 'Tail result survives' })}\n`));
      child.emit('close', 0);
    },
  });
  const result = await runner.run(baseOptions());
  assert.equal(extractResultTextFromStreamJson(result.outputText ?? ''), 'Tail result survives');
});

test('Windows prompt file is removed after an asynchronous launch error', async () => {
  const { calls, runner } = createHarness({
    os: 'win32',
    onSpawn: (child) => child.emit('error', new Error('launch failed')),
  });
  const result = await runner.run(baseOptions());
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, 'launch failed');
  assert.equal(calls.removed.length, 1);
});

test('Windows prompt file is removed after cancellation', async () => {
  const controller = new AbortController();
  const { calls, runner } = createHarness({ os: 'win32' });
  queueMicrotask(() => controller.abort());
  const result = await runner.run(baseOptions({ signal: controller.signal }));
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls.terminations, [{ isWindows: true, reason: 'cancel' }]);
  assert.equal(calls.removed.length, 1);
});

test('Windows prompt file is removed after idle timeout', async () => {
  const { calls, runner } = createHarness({ os: 'win32' });
  const result = await runner.run(baseOptions({ idleTimeoutMs: 5, timeoutMs: 1_000 }));
  assert.equal(result.idleTimedOut, true);
  assert.deepEqual(calls.terminations, [{ isWindows: true, reason: 'timeout' }]);
  assert.equal(calls.removed.length, 1);
});

test('Windows prompt file is removed after fail-safe timeout', async () => {
  const { calls, runner } = createHarness({ os: 'win32' });
  const result = await runner.run(baseOptions({ idleTimeoutMs: 1_000, timeoutMs: 5 }));
  assert.equal(result.idleTimedOut, false);
  assert.deepEqual(calls.terminations, [{ isWindows: true, reason: 'timeout' }]);
  assert.equal(calls.removed.length, 1);
});

test('Unix timeout terminates the detached process group path', async () => {
  const { calls, runner } = createHarness({ os: 'linux' });
  const result = await runner.run(baseOptions({ idleTimeoutMs: 1_000, timeoutMs: 5 }));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls.terminations, [{ isWindows: false, reason: 'timeout' }]);
});
