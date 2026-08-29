import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildOmpArgs, getOmpExecutablePreference, OmpRunner, toOmpPowerShellEncodedCommand } from './omp.js';
import type { RunnerOptions } from './types.js';

const PROMPT_FILE = '/repo/.agentteams/runner/tmp/trigger-1.prompt.md';
const CWD = '/repo';

test('buildOmpArgs uses print mode, json output, yolo approval, and an @file prompt', () => {
  assert.deepEqual(buildOmpArgs(PROMPT_FILE, CWD), [
    '-p',
    '--mode',
    'json',
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

// text 모드는 실행 내내 stdout이 비어 있어 idle 타이머를 굶긴다. json 모드가 스트리밍의 전제다.
test('buildOmpArgs always requests the json output mode', () => {
  for (const model of ['default', 'anthropic/claude-sonnet-4', null, undefined]) {
    const args = buildOmpArgs(PROMPT_FILE, CWD, model);
    assert.equal(args.includes('--mode'), true, `model ${JSON.stringify(model)} lost --mode`);
    assert.equal(args[args.indexOf('--mode') + 1], 'json');
  }
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
  assert.equal(script.includes("'--mode' 'json'"), true, 'the Windows command must stream json too');
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

const ompEventChunk = (event: Record<string, unknown>): Buffer => Buffer.from(`${JSON.stringify(event)}\n`);

// json 모드에서는 최종 답변이 스트림 이벤트로 온다. 진행 문구는 결과에 섞이면 안 된다.
test('OmpRunner captures the final assistant text from the stream, not the raw events', async () => {
  const runner = createStreamingRunner((child) => {
    child.stderr.emit('data', Buffer.from('Still starting after 12s — phase: module load / pre-phase work\n'));
    child.stdout.emit('data', ompEventChunk({ type: 'session', version: 3, id: 'session-1', cwd: '/repo' }));
    child.stdout.emit(
      'data',
      ompEventChunk({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'OMP_STDOUT_PROBE_ANSWER_42' },
      }),
    );
    child.stdout.emit(
      'data',
      ompEventChunk({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'OMP_STDOUT_PROBE_ANSWER_42' }],
          stopReason: 'stop',
        },
      }),
    );
    child.emit('close', 0);
  });

  const result = await runner.run(streamingOptions);

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputText, 'OMP_STDOUT_PROBE_ANSWER_42');
  assert.equal(result.lastOutput, 'OMP_STDOUT_PROBE_ANSWER_42');
  assert.equal(result.errorMessage, undefined);
});

test('OmpRunner preserves streamed assistant text when the process ends before a terminal event', async () => {
  const runner = createStreamingRunner((child) => {
    child.stdout.emit(
      'data',
      ompEventChunk({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', content: 'Partial but useful answer' },
      }),
    );
    child.emit('close', 1);
  });

  const result = await runner.run(streamingOptions);

  assert.equal(result.exitCode, 1);
  assert.equal(result.outputText, 'Partial but useful answer');
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

// 2026-08-29 실측(omp/18.0.6, macOS arm64): `--mode json` 스트림은 실행 내내 NDJSON을 흘린다.
// 아래 두 테스트는 현재 배선의 결함을 고정한다 — Task 2가 통과시킨다.
const successFixturePath = fileURLToPath(new URL('./fixtures/omp-events.jsonl', import.meta.url));
const errorFixturePath = fileURLToPath(new URL('./fixtures/omp-events-error.jsonl', import.meta.url));

test('OmpRunner forwards stderr chunks to onStderrChunk', async () => {
  const stderrChunks: Array<{ chunk: string; category: string }> = [];
  const runner = createStreamingRunner((child) => {
    child.stderr.emit('data', Buffer.from('Still starting after 12s — phase: module load / pre-phase work\n'));
    child.emit('close', 0);
  });

  await runner.run({
    ...streamingOptions,
    onStderrChunk: (chunk, category) => stderrChunks.push({ chunk, category }),
  });

  assert.equal(stderrChunks.length, 1);
  assert.equal(stderrChunks[0]?.category, 'STDERR');
  assert.match(stderrChunks[0]?.chunk ?? '', /Still starting after 12s/);
});

test('OmpRunner turns the NDJSON stream into THINKING/TOOL/TEXT log entries', async () => {
  const fixture = await readFile(successFixturePath, 'utf8');
  const entries: Array<{ message: string; category: string }> = [];
  const runner = createStreamingRunner((child) => {
    for (const line of fixture.split('\n').filter((candidate) => candidate.length > 0)) {
      child.stdout.emit('data', Buffer.from(`${line}\n`));
    }
    child.emit('close', 0);
  });

  const result = await runner.run({
    ...streamingOptions,
    onStdoutChunk: (chunk, category) => entries.push({ message: chunk, category }),
  });

  const categories = new Set(entries.map((entry) => entry.category));
  assert.equal(categories.has('THINKING'), true, 'thinking events must reach the trigger log');
  assert.equal(categories.has('TOOL'), true, 'tool events must reach the trigger log');
  assert.equal(categories.has('TEXT'), true, 'assistant text must reach the trigger log');
  assert.equal(
    entries.some((entry) => entry.message.trimStart().startsWith('{"type"')),
    false,
    'raw NDJSON must not be forwarded as a log line',
  );
  assert.equal(result.outputText, 'VERIFIED alpha beta gamma');
});

// 2026-08-29 실측: 잘못된 API 키로도 omp는 exit 0을 돌려준다. 실패는 스트림에만 실려 있다.
test('OmpRunner reports the provider failure that omp hid behind exit code 0', async () => {
  const fixture = await readFile(errorFixturePath, 'utf8');
  const runner = createStreamingRunner((child) => {
    child.stdout.emit('data', Buffer.from(fixture));
    child.emit('close', 0);
  });

  const result = await runner.run(streamingOptions);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.errorMessage ?? '', /401/);
  assert.match(result.errorMessage ?? '', /Incorrect API key provided/);
  assert.equal(result.outputText, undefined, 'a failed run must not report an answer');
});

// 스트리밍의 요지: 로그 엔트리는 종료 시점 일괄이 아니라 라인이 도착할 때마다 나와야 한다.
// (그래야 idle 타이머가 계속 리셋되고 러너 요청 로그가 실시간으로 쌓인다.)
test('OmpRunner emits log entries while the process is still running', async () => {
  const fixture = await readFile(successFixturePath, 'utf8');
  const entries: string[] = [];
  let entriesBeforeClose = 0;
  const runner = createStreamingRunner((child) => {
    for (const line of fixture.split('\n').filter((candidate) => candidate.length > 0)) {
      child.stdout.emit('data', Buffer.from(`${line}\n`));
    }
    entriesBeforeClose = entries.length;
    child.emit('close', 0);
  });

  await runner.run({ ...streamingOptions, onStdoutChunk: (chunk) => entries.push(chunk) });

  assert.equal(entriesBeforeClose > 0, true, 'entries must reach the trigger log before the process closes');
  assert.equal(entriesBeforeClose, entries.length, 'no entry may be held back until close');
});
