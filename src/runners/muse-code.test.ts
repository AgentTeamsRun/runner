import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildMuseCodeArgs, MuseCodeRunner, toMuseCodePowerShellEncodedCommand } from './muse-code.js';
import { findMuseCodeExecutable } from './muse-code-identity.js';
import { createMuseCodeStreamConsumer } from './muse-code-json-parser.js';
import type { RunnerOptions } from './types.js';

const options: RunnerOptions = {
  triggerId: 'muse-test',
  prompt: '- 작업',
  authPath: '/repo',
  apiKey: 'key',
  apiUrl: 'https://example.com',
  teamId: 'team',
  projectId: 'project',
  timeoutMs: 1000,
  idleTimeoutMs: 1000,
  agentConfigId: 'agent',
  runnerType: 'MUSE_CODE',
};
const event = (payload_type: string, payload: object) =>
  JSON.stringify({ schema_version: 1, payload_type, payload }) + '\n';

test('Muse arguments disable approval and sandbox via --yolo and pass prompt, model, and effort without shell interpolation', () => {
  const args = buildMuseCodeArgs("/repo/a'b.md", ' model-id ', 'high');
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--yolo',
    '--prompt-file',
    "/repo/a'b.md",
    '--model',
    'model-id',
    '--reasoning-effort',
    'high',
  ]);
  for (const model of ['default', null, undefined, ' '])
    assert.equal(buildMuseCodeArgs('/p', model).includes('--model'), false);
  const script = Buffer.from(
    toMuseCodePowerShellEncodedCommand("C:\\a'b\\muse.exe", "/repo/a'b.md", 'model-id', 'high'),
    'base64',
  ).toString('utf16le');
  for (const arg of args) assert.ok(script.includes(`'${arg.replaceAll("'", "''")}'`));
});

test('Muse identity rejects CMS candidates and selects the official installation', async () => {
  const selected = await findMuseCodeExecutable(['muse'], {
    resolveExecutablePathsWithPreferenceAsync: async () => ['/cms/muse', '/official/muse'],
    runProbeCommand: async (path) =>
      path.includes('official') ? 'muse — interactive terminal coding agent' : 'A CMS Scaffolding Tool',
  });
  assert.equal(selected, '/official/muse');
});

const collect = (options?: { verbose?: boolean }) => {
  const entries: { message: string; category: string; toolName?: string }[] = [];
  const parser = createMuseCodeStreamConsumer((batch) => entries.push(...batch), options);
  return { parser, entries };
};
const textMessages = (entries: { message: string; category: string }[]) =>
  entries.filter((entry) => entry.category === 'TEXT').map((entry) => entry.message);

test('Muse parser replays real echo fixture with arbitrary chunk boundaries and drops unmapped envelopes', async () => {
  const fixture = await readFile(new URL('./fixtures/muse-code-events.jsonl', import.meta.url), 'utf8');
  const { parser, entries } = collect();
  for (let offset = 0; offset < fixture.length; offset += 7) parser.push(fixture.slice(offset, offset + 7));
  parser.flush();
  assert.equal(parser.getFinalText(), 'echo: Reply with Muse fixture OK.');
  // 최종 답변은 조각 없이 한 행으로, 그리고 한 번만 남는다.
  assert.deepEqual(textMessages(entries), ['echo: Reply with Muse fixture OK.']);
  assert.equal(
    entries.some((entry) => entry.message.includes('"schema_version"')),
    false,
    'raw MSP envelopes must not reach the server log',
  );
  assert.equal(
    entries.some((entry) => entry.message.includes('task.lifecycle')),
    false,
  );
  parser.push(event('run.terminal.failed', { reason: 'API error 402 billing_error' }).trimEnd());
  parser.flush();
  assert.equal(parser.getFailureMessage(), 'API error 402 billing_error');
});

test('Muse parser keeps unmapped envelopes only in verbose mode', async () => {
  const fixture = await readFile(new URL('./fixtures/muse-code-events.jsonl', import.meta.url), 'utf8');
  const { parser, entries } = collect({ verbose: true });
  parser.push(fixture);
  parser.flush();
  const raw = entries.filter((entry) => entry.category === 'SYSTEM' && entry.message.includes('"schema_version"'));
  assert.ok(raw.some((entry) => entry.message.includes('session.workspace_branch.observed')));
  assert.deepEqual(textMessages(entries), ['echo: Reply with Muse fixture OK.']);
});

test('Muse parser merges token deltas into bounded rows and never re-emits an already streamed answer', () => {
  const { parser, entries } = collect();
  for (const text of ['Hello', ' wor', 'ld.', ' Second', ' para\nThird', ' line']) {
    parser.push(event('run.output.delta', { text }));
  }
  assert.deepEqual(textMessages(entries), ['Hello world.', 'Second para']);
  parser.push(event('run.terminal.completed', { text: 'Hello world. Second para\nThird line' }));
  parser.flush();
  assert.deepEqual(textMessages(entries), ['Hello world.', 'Second para', 'Third line']);
  assert.equal(parser.getFinalText(), 'Hello world. Second para\nThird line');
});

test('Muse parser logs the terminal text as one row when the delta stream does not match it', () => {
  const { parser, entries } = collect();
  parser.push(event('run.output.delta', { text: 'partial' }));
  parser.push(event('run.terminal.completed', { text: 'Complete final answer' }));
  parser.flush();
  assert.deepEqual(textMessages(entries), ['Complete final answer']);
});

test('Muse parser caps the streamed text fallback', () => {
  const { parser } = collect();
  parser.push(event('run.output.delta', { text: 'x'.repeat(150_000) }));
  parser.push(event('run.output.delta', { text: 'y'.repeat(100_000) }));
  parser.flush();
  assert.equal(parser.getStreamedTextFallback()?.length, 200_000);
});

for (const code of [0, 1, 2]) {
  test(`Muse runner preserves exit ${code} and cleans up the prompt`, async () => {
    let removed = false;
    let spawnOptions: object | undefined;
    const runner = new MuseCodeRunner({
      platform: () => 'linux',
      resolveExecutablePathsWithPreferenceAsync: async () => ['/official/muse'],
      runProbeCommand: async () => 'muse — interactive terminal coding agent',
      mkdir: (async () => undefined) as never,
      writeFile: (async () => undefined) as never,
      rm: (async () => {
        removed = true;
      }) as never,
      createWriteStream: (() => new PassThrough()) as never,
      setupCloseWatchdog: (() => ({ cancel() {} })) as never,
      spawn: ((_cmd: string, _args: string[], opts: object) => {
        spawnOptions = opts;
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          pid: 123,
        });
        setTimeout(() => {
          child.stdout.write(
            event(
              code === 0 ? 'run.terminal.completed' : 'run.terminal.failed',
              code === 0 ? { text: '완료' } : { reason: 'specific failure' },
            ),
          );
          child.emit('close', code);
        }, 0);
        return child;
      }) as never,
    });
    const result = await runner.run(options);
    assert.equal(result.exitCode, code);
    assert.equal(removed, true);
    assert.equal((spawnOptions as { windowsHide: boolean }).windowsHide, true);
    assert.equal((spawnOptions as { cwd: string }).cwd, '/repo');
    if (code === 0) assert.equal(result.outputText, '완료');
    else assert.equal(result.errorMessage, 'specific failure');
  });
}

for (const kind of ['timeout', 'cancel'] as const) {
  test(`Muse runner reports ${kind} and terminates its process`, async () => {
    let child: EventEmitter;
    let terminated = false;
    const controller = new AbortController();
    const runner = new MuseCodeRunner({
      platform: () => 'linux',
      resolveExecutablePathsWithPreferenceAsync: async () => ['/muse'],
      runProbeCommand: async () => 'muse — interactive terminal coding agent',
      mkdir: (async () => undefined) as never,
      writeFile: (async () => undefined) as never,
      rm: (async () => undefined) as never,
      createWriteStream: (() => new PassThrough()) as never,
      setupCloseWatchdog: (() => ({ cancel() {} })) as never,
      spawn: (() => {
        child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123 });
        return child;
      }) as never,
      terminateRunnerChild: (() => {
        terminated = true;
        setTimeout(() => child.emit('close', null), 0);
      }) as never,
    });
    if (kind === 'cancel') controller.abort();
    const result = await runner.run({ ...options, signal: controller.signal, idleTimeoutMs: 10 });
    assert.equal(terminated, true);
    assert.equal(kind === 'cancel' ? result.cancelled : result.idleTimedOut, true);
  });
}

test('Muse real model tool fixture summarizes the bash task as TOOL and keeps the final output intact', async () => {
  const fixture = await readFile(new URL('./fixtures/muse-code-tool-events.jsonl', import.meta.url), 'utf8');
  const { parser, entries } = collect();
  parser.push(fixture);
  parser.flush();
  const tools = entries.filter((entry) => entry.category === 'TOOL');
  assert.deepEqual(
    tools.map((entry) => [entry.message, entry.toolName]),
    [['[Tool] tool.bash (proposed)', 'tool.bash']],
  );
  assert.deepEqual(textMessages(entries), ['Output: `muse-verification-ok`']);
  assert.equal(
    entries.some((entry) => entry.message.includes('"schema_version"')),
    false,
  );
  assert.equal(parser.getFinalText(), 'Output: `muse-verification-ok`');
});

test('Muse parser reports tool lifecycle stages once the task kind is known', () => {
  const { parser, entries } = collect();
  const task_id = 't1';
  parser.push(event('task.lifecycle.proposed', { event: { kind: 'proposed', task_id, task_kind: 'tool.bash' } }));
  parser.push(event('task.lifecycle.accepted', { event: { kind: 'accepted', task_id } }));
  parser.push(event('task.lifecycle.started', { event: { kind: 'started', task_id } }));
  parser.push(event('task.lifecycle.completed', { event: { kind: 'completed', task_id } }));
  parser.push(event('task.lifecycle.proposed', { event: { kind: 'proposed', task_id: 'm1', task_kind: 'model.x' } }));
  parser.flush();
  assert.deepEqual(
    entries.map((entry) => entry.message),
    ['[Tool] tool.bash (proposed)', '[Tool] tool.bash (started)', '[Tool] tool.bash (completed)'],
  );
});

const runWithChild = async (feed: (child: { stdout: PassThrough; stderr: PassThrough } & EventEmitter) => void) => {
  const runner = new MuseCodeRunner({
    platform: () => 'linux',
    resolveExecutablePathsWithPreferenceAsync: async () => ['/official/muse'],
    runProbeCommand: async () => 'muse — interactive terminal coding agent',
    mkdir: (async () => undefined) as never,
    writeFile: (async () => undefined) as never,
    rm: (async () => undefined) as never,
    createWriteStream: (() => new PassThrough()) as never,
    setupCloseWatchdog: (() => ({ cancel() {} })) as never,
    spawn: (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
      setTimeout(() => feed(child), 0);
      return child;
    }) as never,
  });
  return runner.run(options);
};

test('Muse runner prefers the latest non-progress stderr line over an early benign warning', async () => {
  const result = await runWithChild((child) => {
    child.stderr.write('muse: workspace root: /repo\n');
    child.stderr.write('A new muse version 1.0.3 is available\n');
    child.stderr.write('Error: API key invalid\n');
    child.stderr.write('run ended with failure\n');
    child.emit('close', 1);
  });
  assert.equal(result.errorMessage, 'Error: API key invalid');
});

test('Muse runner keeps lastOutput as a bounded text preview and ignores non-text entries', async () => {
  const long = 'a'.repeat(1_000);
  const result = await runWithChild((child) => {
    child.stdout.write(event('run.output.delta', { text: `${long}.` }));
    child.stdout.write(
      event('task.lifecycle.proposed', { event: { kind: 'proposed', task_id: 't', task_kind: 'tool.bash' } }),
    );
    child.emit('close', 1);
  });
  assert.equal(result.lastOutput?.length, 403);
  assert.ok(result.lastOutput?.startsWith('aaaa'));
  assert.ok(result.lastOutput?.endsWith('...'));
  assert.equal(result.errorMessage, result.lastOutput);
});
