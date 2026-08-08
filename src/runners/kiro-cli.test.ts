import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKiroCliArgs,
  createAnsiStripper,
  getKiroExecutablePreference,
  KiroCliRunner,
  stripAnsiSequences,
  toKiroPowerShellEncodedCommand,
} from './kiro-cli.js';
import type { RunnerOptions } from './types.js';

const ESC = '\u001B';

test('buildKiroCliArgs uses the headless chat contract with trusted tools', () => {
  assert.deepEqual(buildKiroCliArgs('hello', null), ['chat', '--no-interactive', '--trust-all-tools', '--', 'hello']);
  assert.deepEqual(buildKiroCliArgs('hello', 'default'), [
    'chat',
    '--no-interactive',
    '--trust-all-tools',
    '--',
    'hello',
  ]);
});

test('buildKiroCliArgs forwards the selected model, including the Kiro default `auto`', () => {
  // `auto`는 Kiro의 실제 모델 식별자(기본값)라서 그대로 전달한다.
  assert.deepEqual(buildKiroCliArgs('hello', 'auto'), [
    'chat',
    '--no-interactive',
    '--trust-all-tools',
    '--model',
    'auto',
    '--',
    'hello',
  ]);
  assert.deepEqual(buildKiroCliArgs('hello', 'claude-haiku-4.5'), [
    'chat',
    '--no-interactive',
    '--trust-all-tools',
    '--model',
    'claude-haiku-4.5',
    '--',
    'hello',
  ]);
});

test('buildKiroCliArgs puts the prompt after `--` so a dash-leading prompt is not parsed as a flag', () => {
  // 실측: 구분자 없이 `-`로 시작하는 프롬프트를 주면 clap이 플래그로 오인해
  // usage만 출력하고 모델을 호출하지 않는다.
  const args = buildKiroCliArgs('- 첫 번째 항목', 'auto');
  const separatorIndex = args.indexOf('--');

  assert.notEqual(separatorIndex, -1);
  assert.equal(args[separatorIndex + 1], '- 첫 번째 항목');
  assert.equal(args[args.length - 1], '- 첫 번째 항목');
});

test('buildKiroCliArgs omits flags that were not verified against the real CLI', () => {
  const args = buildKiroCliArgs('hello', 'auto');

  // `--effort`는 잘못된 레벨도 조용히 수용되고 low/max가 동일 크레딧을 소모해
  // 효과를 실증하지 못했다. 미확인 플래그는 인자에 넣지 않는다.
  assert.equal(args.includes('--effort'), false);
  assert.equal(args.includes('--agent'), false);
  assert.equal(args.includes('--require-mcp-startup'), false);
  assert.equal(args.includes('--resume'), false);
});

test('uses platform-specific Kiro executable preferences', () => {
  assert.deepEqual(getKiroExecutablePreference(false), ['kiro-cli']);
  assert.deepEqual(getKiroExecutablePreference(true), ['kiro-cli.exe', 'kiro-cli']);
});

test('stripAnsiSequences removes the escape codes Kiro emits even when piped', () => {
  assert.equal(stripAnsiSequences(`${ESC}[38;5;141m> ${ESC}[0mOK`), '> OK');
  assert.equal(stripAnsiSequences(`${ESC}[32mAll tools are now trusted${ESC}[0m`), 'All tools are now trusted');
  assert.equal(stripAnsiSequences(`${ESC}[?25l${ESC}[1G${ESC}[0m done${ESC}[?25h`), ' done');
  assert.equal(stripAnsiSequences('plain text'), 'plain text');
});

test('createAnsiStripper removes an escape sequence split across chunk boundaries', () => {
  const stripper = createAnsiStripper();

  // 한 시퀀스가 두 data 이벤트에 걸쳐 도착하는 경우: 청크 단위 제거로는 어느 쪽도 매치되지 않는다.
  assert.equal(stripper.push(`Kiro ${ESC}[38;5`), 'Kiro ');
  assert.equal(stripper.push(';141mresult'), 'result');
  assert.equal(stripper.flush(), '');
});

test('createAnsiStripper drops spinner carriage returns and a dangling escape tail', () => {
  const stripper = createAnsiStripper();

  assert.equal(stripper.push('working\rdone'), 'workingdone');
  assert.equal(stripper.push(`tail${ESC}[`), 'tail');
  assert.equal(stripper.flush(), '');
});

test('createAnsiStripper releases a tail that is too long to be an escape sequence', () => {
  const stripper = createAnsiStripper();
  const notASequence = `${ESC}${'x'.repeat(80)}`;

  // 종결자 없이 길어진 꼬리를 계속 붙잡고 있으면 출력이 통째로 사라진다.
  assert.equal(stripper.push(notASequence), 'x'.repeat(80));
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

test('toKiroPowerShellEncodedCommand reads the prompt from a file and preserves Kiro arguments', () => {
  const script = decodePowerShellCommand(
    toKiroPowerShellEncodedCommand(
      'C:/kiro-cli.exe',
      'C:/repo/.agentteams/runner/tmp/trigger.prompt.txt',
      'claude-haiku-4.5',
    ),
  );

  assert.match(script, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(script, /'chat' '--no-interactive' '--trust-all-tools' '--model' 'claude-haiku-4\.5' '--' \$promptText/);
});

test('toKiroPowerShellEncodedCommand omits the internal default model sentinel', () => {
  const script = decodePowerShellCommand(
    toKiroPowerShellEncodedCommand('C:/kiro-cli.exe', 'C:/repo/.agentteams/runner/tmp/trigger.prompt.txt', 'default'),
  );

  assert.match(script, /'chat' '--no-interactive' '--trust-all-tools' '--' \$promptText/);
  assert.doesNotMatch(script, /--model/);
});

type FakeChild = EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };

const createFakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4343;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

const createRunner = (emit: (child: FakeChild) => void, spawned?: SpawnRecord[]): [KiroCliRunner, FakeChild] => {
  const child = createFakeChild();
  const runner = new KiroCliRunner({
    platform: () => 'linux',
    resolveExecutablePathWithPreference: (() => '/home/user/.local/bin/kiro-cli') as never,
    describeExecutableResolution: (() => ({
      requestedCommand: 'kiro-cli',
      resolvedExecutablePath: '/home/user/.local/bin/kiro-cli',
      platform: 'linux',
      shell: false,
    })) as never,
    mkdir: (async () => undefined) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel: () => {} })) as never,
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawned?.push({ command, args, options });
      queueMicrotask(() => emit(child));
      return child;
    }) as never,
  });

  return [runner, child];
};

type SpawnRecord = { command: string; args: readonly string[]; options: Record<string, unknown> };

const baseOptions: RunnerOptions = {
  triggerId: 'trigger-kiro',
  prompt: 'hello',
  authPath: '/repo',
  apiKey: 'key',
  apiUrl: 'https://api.example.com',
  teamId: 'team',
  projectId: 'project',
  timeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  agentConfigId: 'agent',
};

test('KiroCliRunner launches headless chat and captures ANSI-stripped text output', async () => {
  const spawned: SpawnRecord[] = [];
  const [runner] = createRunner((child) => {
    child.stdout.emit('data', Buffer.from(`${ESC}[38;5;141m> ${ESC}[0mKiro result`));
    // 정상 실행에서도 stderr로 신뢰 배너와 크레딧 요약이 나온다.
    child.stderr.emit('data', Buffer.from(`${ESC}[32mAll tools are now trusted${ESC}[0m`));
    child.stderr.emit('data', Buffer.from(' \u25B8 Credits: 0.03 \u2022 Time: 2s'));
    child.emit('close', 0);
  }, spawned);

  const result = await runner.run({
    ...baseOptions,
    model: 'claude-haiku-4.5',
    onStderrChunk: () => assert.fail('Kiro stderr progress must not be reported as an error chunk'),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputText, '> Kiro result');
  assert.equal(result.lastOutput, '> Kiro result');
  assert.equal(result.errorMessage, undefined);
  assert.equal(spawned[0]?.command, '/home/user/.local/bin/kiro-cli');
  assert.deepEqual(spawned[0]?.args, [
    'chat',
    '--no-interactive',
    '--trust-all-tools',
    '--model',
    'claude-haiku-4.5',
    '--',
    'hello',
  ]);
  assert.equal(spawned[0]?.options.windowsHide, true);
});

test('reports the real stderr cause instead of the trailing progress line on failure', async () => {
  const [runner] = createRunner((child) => {
    child.stderr.emit(
      'data',
      Buffer.from("error: Model 'bogus-model-xyz' does not exist. Available models: auto, claude-sonnet-4.5"),
    );
    // 오류 이후에도 커서 복원 시퀀스 같은 진행 로그가 뒤따를 수 있다.
    child.stderr.emit('data', Buffer.from(`${ESC}[1G${ESC}[?25h`));
    child.emit('close', 1);
  });

  const result = await runner.run({ ...baseOptions, triggerId: 'trigger-kiro-model-error' });

  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? '', /Model 'bogus-model-xyz' does not exist/);
});

test('surfaces the MCP startup failure cause behind exit code 3', async () => {
  const [runner] = createRunner((child) => {
    child.stderr.emit('data', Buffer.from('Error: One or more MCP servers failed to start'));
    child.emit('close', 3);
  });

  const result = await runner.run({ ...baseOptions, triggerId: 'trigger-kiro-mcp' });

  assert.equal(result.exitCode, 3);
  assert.match(result.errorMessage ?? '', /MCP servers failed to start/);
});

test('keeps the Bedrock error as the cause even though it does not start with "error"', async () => {
  const [runner] = createRunner((child) => {
    child.stderr.emit(
      'data',
      Buffer.from('Bedrock error message: The model returned the following errors: input_schema is invalid'),
    );
    // 실패한 실행도 종료 직전 크레딧 요약을 stderr로 보낸다. 이게 사유를 덮으면 안 된다.
    child.stderr.emit('data', Buffer.from(' ▸ Credits: 0.01 • Time: 1s'));
    child.emit('close', 1);
  });

  const result = await runner.run({ ...baseOptions, triggerId: 'trigger-kiro-bedrock' });

  assert.match(result.errorMessage ?? '', /Bedrock error message/);
});

test('keeps the first error chunk when later output also looks like an error', async () => {
  const [runner] = createRunner((child) => {
    child.stderr.emit('data', Buffer.from('Amazon Q is having trouble responding right now'));
    child.stderr.emit('data', Buffer.from('ERROR: retry limit reached'));
    child.emit('close', 1);
  });

  const result = await runner.run({ ...baseOptions, triggerId: 'trigger-kiro-first-error' });

  assert.match(result.errorMessage ?? '', /having trouble responding/);
});

test('falls back to a generic failure message when stderr carried only progress output', async () => {
  const [runner] = createRunner((child) => {
    child.stderr.emit('data', Buffer.from(`${ESC}[?25l${ESC}[?25h`));
    child.emit('close', 1);
  });

  const result = await runner.run({ ...baseOptions, triggerId: 'trigger-kiro-opaque' });

  assert.equal(result.errorMessage, 'Runner exited with code 1');
});
