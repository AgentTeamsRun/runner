import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildKimiCliArgs,
  getKimiExecutablePreference,
  KimiCliRunner,
  toKimiPowerShellEncodedCommand,
} from './kimi-cli.js';
import type { RunnerOptions } from './types.js';

test('buildKimiCliArgs uses Kimi print mode without approval bypass flags', () => {
  assert.deepEqual(buildKimiCliArgs('hello', null), ['-p', 'hello', '--output-format', 'stream-json']);
  assert.deepEqual(buildKimiCliArgs('hello', 'default'), ['-p', 'hello', '--output-format', 'stream-json']);
  assert.deepEqual(buildKimiCliArgs('hello', 'k3'), ['-p', 'hello', '-m', 'k3', '--output-format', 'stream-json']);
});

test('uses platform-specific Kimi executable preferences', () => {
  assert.deepEqual(getKimiExecutablePreference(false), ['kimi']);
  assert.deepEqual(getKimiExecutablePreference(true), ['kimi.cmd', 'kimi']);
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

test('toKimiPowerShellEncodedCommand reads the prompt from a file and preserves Kimi arguments', () => {
  const script = decodePowerShellCommand(
    toKimiPowerShellEncodedCommand('C:/kimi.cmd', 'C:/repo/.agentteams/runner/tmp/trigger.prompt.txt', 'k3'),
  );

  assert.match(script, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(script, /'-p' \$promptText '-m' 'k3' '--output-format' 'stream-json'/);
  assert.doesNotMatch(script, /--yolo|--auto|--plan/);
});

test('toKimiPowerShellEncodedCommand omits the default model', () => {
  const script = decodePowerShellCommand(
    toKimiPowerShellEncodedCommand('C:/kimi.cmd', 'C:/repo/.agentteams/runner/tmp/trigger.prompt.txt', 'default'),
  );

  assert.match(script, /'-p' \$promptText/);
  assert.match(script, /'--output-format' 'stream-json'/);
  assert.doesNotMatch(script, /-m/);
});

type FakeChild = EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };

const createFakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

test('KimiCliRunner replays stream-json into sanitized logs and final text', async () => {
  const fixture = await readFile(fileURLToPath(new URL('./fixtures/kimi-events.jsonl', import.meta.url)), 'utf8');
  const child = createFakeChild();
  const spawned: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const chunks: { message: string; category: string }[] = [];
  const runner = new KimiCliRunner({
    platform: () => 'linux',
    resolveExecutablePathWithPreference: (() => '/usr/local/bin/kimi') as never,
    describeExecutableResolution: (() => ({
      requestedCommand: 'kimi',
      resolvedExecutablePath: '/usr/local/bin/kimi',
      platform: 'linux',
      shell: false,
    })) as never,
    mkdir: (async () => undefined) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel: () => {} })) as never,
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options });
      queueMicrotask(() => {
        const cut = Math.floor(fixture.length / 2);
        child.stdout.emit('data', Buffer.from(fixture.slice(0, cut)));
        child.stdout.emit('data', Buffer.from(fixture.slice(cut)));
        child.stderr.emit('data', Buffer.from('tool progress'));
        child.emit('close', 0);
      });
      return child;
    }) as never,
  });
  const options: RunnerOptions = {
    triggerId: 'trigger-kimi',
    prompt: 'hello',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'KIMI_CLI',
    model: 'k3',
    onStdoutChunk: (message, category) => {
      chunks.push({ message, category });
    },
    onStderrChunk: () => assert.fail('Kimi stderr progress must not be reported as an error chunk'),
  };

  const result = await runner.run(options);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    chunks.map((chunk) => chunk.category),
    ['TOOL', 'TOOL', 'TEXT', 'RESULT'],
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.message),
    ['[Tool] Read: input.txt', '[Tool] Write: output.txt', 'Done.', '[Result] Completed'],
  );
  const logged = chunks.map((chunk) => chunk.message).join('\n');
  assert.ok(!logged.includes('{"role"'));
  assert.ok(!logged.includes('hello kimi'));
  assert.equal(
    result.outputText,
    'Done. `input.txt` contained "hello kimi", and I wrote that single line to `output.txt`.',
  );
  assert.equal(result.lastOutput, '[Result] Completed');
  assert.equal(result.errorMessage, undefined);
  assert.equal(spawned[0]?.command, '/usr/local/bin/kimi');
  assert.deepEqual(spawned[0]?.args, ['-p', 'hello', '-m', 'k3', '--output-format', 'stream-json']);
  assert.equal(spawned[0]?.options.windowsHide, true);

  // 실행 스냅샷 3종이 자식 프로세스 환경에 실려야 CLI가 --runner-type/--model을 폴백할 수 있다.
  const env = spawned[0]?.options.env as Record<string, string> | undefined;
  assert.equal(env?.AGENTTEAMS_RUNNER_TYPE, 'KIMI_CLI');
  assert.equal(env?.AGENTTEAMS_MODEL, 'k3');
  assert.equal(env !== undefined && 'AGENTTEAMS_FAST_MODE' in env, false);
});

test('uses Kimi stderr only as the failure message when the process exits unsuccessfully', async () => {
  const child = createFakeChild();
  const runner = new KimiCliRunner({
    platform: () => 'linux',
    resolveExecutablePathWithPreference: (() => '/usr/local/bin/kimi') as never,
    describeExecutableResolution: (() => ({
      requestedCommand: 'kimi',
      resolvedExecutablePath: '/usr/local/bin/kimi',
      platform: 'linux',
      shell: false,
    })) as never,
    mkdir: (async () => undefined) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel: () => {} })) as never,
    spawn: (() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('resuming session'));
        child.emit('close', 17);
      });
      return child;
    }) as never,
  });

  const result = await runner.run({
    triggerId: 'trigger-kimi-error',
    prompt: 'hello',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'KIMI_CLI',
  });

  assert.equal(result.outputText, undefined);
  assert.equal(result.lastOutput, '');
  assert.equal(result.errorMessage, 'resuming session');
});

test('returns the last Kimi stderr preview when the process exits unsuccessfully', async () => {
  const child = createFakeChild();
  const runner = new KimiCliRunner({
    platform: () => 'linux',
    resolveExecutablePathWithPreference: (() => '/usr/local/bin/kimi') as never,
    describeExecutableResolution: (() => ({
      requestedCommand: 'kimi',
      resolvedExecutablePath: '/usr/local/bin/kimi',
      platform: 'linux',
      shell: false,
    })) as never,
    mkdir: (async () => undefined) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel: () => {} })) as never,
    spawn: (() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('No model configured'));
        child.emit('close', 1);
      });
      return child;
    }) as never,
  });

  const result = await runner.run({
    triggerId: 'trigger-kimi-stderr-error',
    prompt: 'hello',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'KIMI_CLI',
  });

  assert.equal(result.errorMessage, 'No model configured');
});
