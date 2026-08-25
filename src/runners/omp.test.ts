import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildOmpArgs, getOmpExecutablePreference, OmpRunner, toOmpPowerShellEncodedCommand } from './omp.js';
import type { RunnerOptions } from './types.js';

const PROMPT_FILE = '/repo/.agentteams/runner/tmp/trigger-1.prompt.md';
const CWD = '/repo';

test('buildOmpArgs uses print mode, yolo approval, and an @file prompt', () => {
  assert.deepEqual(buildOmpArgs(PROMPT_FILE, CWD), [
    '-p',
    '--no-session',
    '--auto-approve',
    '--approval-mode',
    'yolo',
    '--cwd',
    CWD,
    `@${PROMPT_FILE}`,
  ]);
});

test('buildOmpArgs never passes the prompt as a leading-dash positional', () => {
  const args = buildOmpArgs(PROMPT_FILE, CWD, 'anthropic/claude-sonnet-4');
  assert.equal(
    args.some((arg) => arg.startsWith('- ') || arg === '- this is a markdown bullet'),
    false,
  );
  assert.equal(args.includes(`@${PROMPT_FILE}`), true);
});

test('buildOmpArgs appends the requested model', () => {
  const args = buildOmpArgs(PROMPT_FILE, CWD, 'anthropic/claude-sonnet-4');
  assert.deepEqual(args.slice(-2), ['--model', 'anthropic/claude-sonnet-4']);
});

test('buildOmpArgs drops the default sentinel and blank models', () => {
  for (const model of ['default', '', '   ', null, undefined]) {
    const args = buildOmpArgs(PROMPT_FILE, CWD, model);
    assert.equal(args.includes('--model'), false, `model ${JSON.stringify(model)} should not be forwarded`);
  }
});

test('getOmpExecutablePreference adds the .exe candidate only on Windows', () => {
  assert.deepEqual(getOmpExecutablePreference(true), ['omp.exe', 'omp']);
  assert.deepEqual(getOmpExecutablePreference(false), ['omp']);
});

test('OmpRunner refuses a conflicting omp before spawning it', async () => {
  let spawnCalled = false;
  const runner = new OmpRunner({
    platform: () => 'linux',
    resolveExecutablePathsWithPreferenceAsync: (async () => ['/usr/local/bin/omp']) as never,
    runProbeCommand: (async () => 'omp 1.0.0\nnew ') as never,
    mkdir: (async () => undefined) as never,
    spawn: (() => {
      spawnCalled = true;
      throw new Error('must not spawn');
    }) as never,
  });
  const options: RunnerOptions = {
    triggerId: 'trigger-omp-identity',
    prompt: 'private runner prompt',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'OMP',
  };

  const result = await runner.run(options);

  assert.equal(spawnCalled, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? '', /official Oh My Pi executable/);
});

test('OmpRunner re-checks the resolved path immediately before spawn', async () => {
  let probeCount = 0;
  let spawnCalled = false;
  let promptRemoved = false;
  const runner = new OmpRunner({
    platform: () => 'linux',
    resolveExecutablePathsWithPreferenceAsync: (async () => ['/usr/local/bin/omp']) as never,
    runProbeCommand: (async () => {
      probeCount += 1;
      return probeCount === 1 ? 'omp v18.0.4\nOh My Pi as an ACP' : 'omp 1.0.0';
    }) as never,
    mkdir: (async () => undefined) as never,
    writeFile: (async () => undefined) as never,
    rm: (async () => {
      promptRemoved = true;
    }) as never,
    spawn: (() => {
      spawnCalled = true;
      throw new Error('must not spawn');
    }) as never,
  });

  const result = await runner.run({
    triggerId: 'trigger-omp-replaced',
    prompt: 'private runner prompt',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'OMP',
  });

  assert.equal(probeCount, 2);
  assert.equal(spawnCalled, false);
  assert.equal(promptRemoved, true);
  assert.match(result.errorMessage ?? '', /changed identity before launch/);
});

test('the Windows command carries exactly the POSIX argument vector', () => {
  const encoded = toOmpPowerShellEncodedCommand('C:\\bin\\omp.exe', PROMPT_FILE, CWD, 'anthropic/claude-sonnet-4');
  const script = Buffer.from(encoded, 'base64').toString('utf16le');

  for (const arg of buildOmpArgs(PROMPT_FILE, CWD, 'anthropic/claude-sonnet-4')) {
    assert.equal(script.includes(`'${arg}'`), true, `Windows command is missing '${arg}'`);
  }
  assert.equal(script.includes("& 'C:\\bin\\omp.exe'"), true);
});

test('the Windows command escapes single quotes in the resolved path', () => {
  const encoded = toOmpPowerShellEncodedCommand("C:\\o'brien\\omp.exe", PROMPT_FILE, CWD);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(script.includes("& 'C:\\o''brien\\omp.exe'"), true);
});

type FakeChild = EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };

const createFakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = 5151;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

const createStreamingRunner = (emit: (child: FakeChild) => void): OmpRunner =>
  new OmpRunner({
    platform: () => 'linux',
    resolveExecutablePathsWithPreferenceAsync: (async () => ['/home/user/.local/bin/omp']) as never,
    runProbeCommand: (async () => 'omp v18.0.4\nRun Oh My Pi as an ACP') as never,
    mkdir: (async () => undefined) as never,
    writeFile: (async () => undefined) as never,
    rm: (async () => undefined) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel: () => {} })) as never,
    terminateRunnerChild: (() => {}) as never,
    spawn: (() => {
      const child = createFakeChild();
      queueMicrotask(() => emit(child));
      return child;
    }) as never,
  });

const streamingOptions: RunnerOptions = {
  triggerId: 'trigger-omp-stream',
  prompt: 'private runner prompt',
  authPath: '/repo',
  apiKey: 'key',
  apiUrl: 'https://api.example.com',
  teamId: 'team',
  projectId: 'project',
  timeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  agentConfigId: 'agent',
  runnerType: 'OMP',
};

// 2026-08-25 실측: 성공 실행은 최종 답변을 stdout으로 내고 stderr에는 `Working...`만 남긴다.
test('OmpRunner captures the stdout answer and keeps the Working progress line out of the result', async () => {
  const runner = createStreamingRunner((child) => {
    child.stderr.emit('data', Buffer.from('Working...\n'));
    child.stdout.emit('data', Buffer.from('OMP_STDOUT_PROBE_ANSWER_42\n'));
    child.emit('close', 0);
  });

  const result = await runner.run(streamingOptions);

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputText, 'OMP_STDOUT_PROBE_ANSWER_42');
  assert.equal(result.lastOutput, 'OMP_STDOUT_PROBE_ANSWER_42');
  assert.equal(result.errorMessage, undefined);
});

// 2026-08-25 실측: `Working...`이 먼저 오고 수 초 뒤 진짜 사유가 별도 청크로 온다.
test('OmpRunner reports the real stderr cause instead of the leading Working progress line', async () => {
  const runner = createStreamingRunner((child) => {
    child.stderr.emit('data', Buffer.from('Working...\n'));
    child.stderr.emit('data', Buffer.from('402 Insufficient credits. This account never purchased credits.\n'));
    child.emit('close', 1);
  });

  const result = await runner.run(streamingOptions);

  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, '402 Insufficient credits. This account never purchased credits.');
});

// 기동이 느릴 때 나오는 2줄 안내도 실패 사유를 덮으면 안 된다.
test('OmpRunner treats the slow-startup notice as progress, not as a failure cause', async () => {
  const runner = createStreamingRunner((child) => {
    child.stderr.emit('data', Buffer.from('Working...\n'));
    child.stderr.emit(
      'data',
      Buffer.from(
        'Still starting after 12s — phase: module load / pre-phase work\n' +
          '  logs: /tmp/omp.log · re-run with PI_DEBUG_STARTUP=1 for streaming phase markers\n',
      ),
    );
    child.stderr.emit('data', Buffer.from('404 No endpoints found for arcee-ai/trinity-mini:free\n'));
    child.emit('close', 1);
  });

  const result = await runner.run(streamingOptions);

  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, '404 No endpoints found for arcee-ai/trinity-mini:free');
});
