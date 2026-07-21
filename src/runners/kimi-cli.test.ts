import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKimiCliArgs,
  getKimiExecutablePreference,
  KimiCliRunner,
  toKimiPowerShellEncodedCommand,
} from './kimi-cli.js';
import type { RunnerOptions } from './types.js';

test('buildKimiCliArgs uses Kimi print mode without approval bypass flags', () => {
  assert.deepEqual(buildKimiCliArgs('hello', null), ['-p', 'hello']);
  assert.deepEqual(buildKimiCliArgs('hello', 'default'), ['-p', 'hello']);
  assert.deepEqual(buildKimiCliArgs('hello', 'k3'), ['-p', 'hello', '-m', 'k3']);
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
  assert.match(script, /'-p' \$promptText '-m' 'k3'/);
  assert.doesNotMatch(script, /--yolo|--auto|--plan/);
});

test('toKimiPowerShellEncodedCommand omits the default model', () => {
  const script = decodePowerShellCommand(
    toKimiPowerShellEncodedCommand('C:/kimi.cmd', 'C:/repo/.agentteams/runner/tmp/trigger.prompt.txt', 'default'),
  );

  assert.match(script, /'-p' \$promptText/);
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

test('KimiCliRunner launches print mode and captures text output', async () => {
  const child = createFakeChild();
  const spawned: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
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
        child.stdout.emit('data', Buffer.from('Kimi result'));
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
    model: 'k3',
    onStderrChunk: () => assert.fail('Kimi stderr progress must not be reported as an error chunk'),
  };

  const result = await runner.run(options);

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputText, 'Kimi result');
  assert.equal(spawned[0]?.command, '/usr/local/bin/kimi');
  assert.deepEqual(spawned[0]?.args, ['-p', 'hello', '-m', 'k3']);
  assert.equal(spawned[0]?.options.windowsHide, true);
});

test('does not use Kimi stderr progress as fallback output or error', async () => {
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
  });

  assert.equal(result.outputText, undefined);
  assert.equal(result.lastOutput, '');
  assert.equal(result.errorMessage, 'Runner exited with code 17');
});
