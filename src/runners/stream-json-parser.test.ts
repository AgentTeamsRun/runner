import assert from 'node:assert/strict';
import test from 'node:test';
import { extractResultTextFromStreamJson } from './claude-code.js';
import {
  createCursorStreamJsonLineParser,
  createResultLineCapturer,
  createStreamJsonLineParser,
  firstSentence,
  parseStreamJsonLine,
  shortenPath,
  summarizeToolUse,
} from './stream-json-parser.js';

test('shortenPath strips cwd prefix and falls back to original when unmatched', () => {
  const cwd = '/Users/justin/Project/Me/AgentTeams';
  assert.equal(shortenPath(`${cwd}/web/src/foo.ts`, cwd), 'web/src/foo.ts');
  assert.equal(shortenPath('/other/place/foo.ts', cwd), '/other/place/foo.ts');
  assert.equal(shortenPath('', cwd), '');
});

test('firstSentence trims to first terminator within cap', () => {
  assert.equal(firstSentence('Hello world. This is the second sentence.'), 'Hello world.');
  assert.equal(firstSentence('No terminator here just a long sentence'), 'No terminator here just a long sentence');
  assert.equal(firstSentence('a'.repeat(200), 50), `${'a'.repeat(50)}...`);
});

test('summarizeToolUse renders human-readable summaries per tool', () => {
  const cwd = '/Users/justin/Project/Me/AgentTeams';
  assert.equal(summarizeToolUse('Read', { file_path: `${cwd}/web/src/foo.ts` }, cwd), 'Read: web/src/foo.ts');
  assert.equal(summarizeToolUse('Edit', { file_path: `${cwd}/daemon/src/index.ts` }, cwd), 'Edit: daemon/src/index.ts');
  assert.equal(summarizeToolUse('Bash', { command: 'git status\necho done', description: '...' }), 'Bash: git status');
  assert.equal(
    summarizeToolUse('Bash', { command: `git -C ${cwd}/web add foo.ts` }, cwd),
    'Bash: git -C ./web add foo.ts',
  );
  assert.equal(summarizeToolUse('Grep', { pattern: 'foo', path: `${cwd}/src` }, cwd), 'Grep: "foo" in src');
  assert.equal(summarizeToolUse('Glob', { pattern: '**/*.ts' }), 'Glob: **/*.ts');
  assert.equal(summarizeToolUse('TaskCreate', { subject: 'Refactor parser' }), 'TaskCreate: Refactor parser');
  assert.equal(summarizeToolUse('TaskUpdate', { taskId: '1', status: 'in_progress' }), 'TaskUpdate: 1 -> in_progress');
  assert.equal(summarizeToolUse('TodoWrite', { todos: [{}, {}, {}] }), 'TodoWrite: 3 item(s)');
  assert.equal(summarizeToolUse('WebSearch', { query: 'node test' }), 'WebSearch: "node test"');
  assert.equal(summarizeToolUse('WebFetch', { url: 'https://example.com' }), 'WebFetch: https://example.com');
  assert.equal(
    summarizeToolUse('CustomTool', { alpha: 1, beta: 2, gamma: 3, delta: 4 }),
    'CustomTool(alpha,beta,gamma)',
  );
  assert.equal(summarizeToolUse('CustomTool', {}), 'CustomTool');
});

test('parseStreamJsonLine skips thinking blocks by default and emits when verbose', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'Let me consider this.' }] },
  });
  assert.deepEqual(parseStreamJsonLine(line), []);
  assert.deepEqual(parseStreamJsonLine(line, { verbose: true }), [
    { level: 'INFO', message: '[Thinking] Let me consider this.' },
  ]);
});

test('parseStreamJsonLine emits readable [Tool] line instead of JSON dump', () => {
  const cwd = '/Users/justin/Project/Me/AgentTeams';
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: `${cwd}/web/src/components/Foo.tsx` },
        },
      ],
    },
  });

  const entries = parseStreamJsonLine(line, { cwd });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'INFO');
  assert.equal(entries[0].message, '[Tool] Read: web/src/components/Foo.tsx');
  assert.ok(!entries[0].message.includes('{'), 'tool line must not contain raw JSON braces');
});

test('parseStreamJsonLine reduces assistant text to first sentence', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Now wire the refetch into the controller. Next steps follow.' }],
    },
  });
  const entries = parseStreamJsonLine(line);
  assert.deepEqual(entries, [{ level: 'INFO', message: 'Now wire the refetch into the controller.' }]);
});

test('parseStreamJsonLine renders system init and result lines', () => {
  const init = JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-4-7',
    tools: ['Read', 'Edit', 'Bash'],
  });
  assert.deepEqual(parseStreamJsonLine(init), [
    { level: 'INFO', message: 'Session initialized (model=claude-opus-4-7, tools=3)' },
  ]);

  const ok = JSON.stringify({ type: 'result', duration_ms: 12345, num_turns: 4 });
  assert.deepEqual(parseStreamJsonLine(ok), [{ level: 'INFO', message: '[Result] Completed in 12s (4 turns)' }]);

  const err = JSON.stringify({
    type: 'result',
    duration_ms: 5000,
    num_turns: 2,
    is_error: true,
    result: 'Idle timeout',
  });
  assert.deepEqual(parseStreamJsonLine(err), [
    { level: 'WARN', message: '[Result] Error after 5s (2 turns): Idle timeout' },
  ]);
});

test('parseStreamJsonLine returns empty for malformed or empty input', () => {
  assert.deepEqual(parseStreamJsonLine(''), []);
  assert.deepEqual(parseStreamJsonLine('   '), []);
  assert.deepEqual(parseStreamJsonLine('not json'), []);
  assert.deepEqual(parseStreamJsonLine('{"no":"type"}'), []);
});

test('createStreamJsonLineParser handles chunked input and forwards options', () => {
  const collected: string[] = [];
  const parser = createStreamJsonLineParser((entries) => collected.push(...entries.map((e) => e.message)), {
    cwd: '/repo',
  });

  const lineA = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
  });
  const lineB = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/b.ts' } }] },
  });

  // Split first line across two pushes to exercise buffering.
  const half = Math.floor(lineA.length / 2);
  parser.push(lineA.slice(0, half));
  parser.push(`${lineA.slice(half)}\n${lineB}\n`);

  assert.deepEqual(collected, ['[Tool] Read: a.ts', '[Tool] Read: b.ts']);
});

test('createResultLineCapturer retains the last result line across chunked input', () => {
  const capturer = createResultLineCapturer();
  assert.equal(capturer.get(), null);

  const firstResult = JSON.stringify({ type: 'result', result: 'first pass done' });
  const secondResult = JSON.stringify({ type: 'result', result: 'final answer' });
  const noise = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });

  capturer.push(`${firstResult}\n${noise}\n`);
  assert.equal(capturer.get(), firstResult);

  // A later result line wins, even when split mid-line across pushes.
  const half = Math.floor(secondResult.length / 2);
  capturer.push(secondResult.slice(0, half));
  capturer.push(`${secondResult.slice(half)}\n`);
  assert.equal(capturer.get(), secondResult);
});

test('createResultLineCapturer flushes a trailing result line with no terminating newline', () => {
  const capturer = createResultLineCapturer();
  const result = JSON.stringify({ type: 'result', result: 'done' });

  capturer.push(result); // no trailing newline; still buffered
  assert.equal(capturer.get(), null);

  capturer.flush();
  assert.equal(capturer.get(), result);
});

test('captured result line survives the head-capped buffer and feeds extractResultTextFromStreamJson', () => {
  const capturer = createResultLineCapturer();

  // Simulate a long run whose head-capped buffer keeps only the early output (no result event).
  const headCappedOutput = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' });
  const resultLine = JSON.stringify({ type: 'result', result: 'The clean final summary.' });

  capturer.push(`${headCappedOutput}\n`);
  capturer.push(`${resultLine}\n`);
  capturer.flush();

  const resultLineFromCapture = capturer.get();
  assert.equal(resultLineFromCapture, resultLine);

  // Mirror finalizeOutputText: re-attach the captured result line the head-cap dropped.
  const finalized = `${headCappedOutput}\n${resultLineFromCapture}`;
  assert.equal(extractResultTextFromStreamJson(finalized), 'The clean final summary.');
});

test('parseStreamJsonLine respects AGENTTEAMS_RUNNER_VERBOSE env when no option given', () => {
  const previous = process.env.AGENTTEAMS_RUNNER_VERBOSE;
  process.env.AGENTTEAMS_RUNNER_VERBOSE = '1';
  try {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hidden by default' }] },
    });
    const entries = parseStreamJsonLine(line);
    assert.equal(entries.length, 1);
    assert.match(entries[0].message, /^\[Thinking\]/);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTTEAMS_RUNNER_VERBOSE;
    } else {
      process.env.AGENTTEAMS_RUNNER_VERBOSE = previous;
    }
  }
});

test('Cursor parser merges small assistant deltas and flushes on sentence, tool, result, and end boundaries', () => {
  const entries: Array<{ level: string; message: string }> = [];
  const parser = createCursorStreamJsonLineParser((next) => entries.push(...next), { cwd: '/repo' });
  const assistant = (text: string) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  parser.push(`${assistant('Reading ')}\n${assistant('the repository. ')}\n`);
  parser.push(
    `${assistant('Opening configuration')}
${JSON.stringify({
  type: 'tool_call',
  subtype: 'started',
  tool_call: { readToolCall: { args: { path: '/repo/config.json' } } },
})}\n`,
  );
  parser.push(`${assistant('Done without punctuation')}\n`);
  parser.push(`${JSON.stringify({ type: 'result', duration_ms: 1500, result: 'sensitive final body' })}\n`);
  parser.flush();

  assert.deepEqual(entries, [
    { level: 'INFO', message: 'Reading the repository.' },
    { level: 'INFO', message: 'Opening configuration' },
    { level: 'INFO', message: '[Tool] Read: config.json (started)' },
    { level: 'INFO', message: 'Done without punctuation' },
    { level: 'INFO', message: '[Result] Completed in 2s' },
  ]);
});

test('Cursor parser bounds assistant entries instead of emitting one log per delta', () => {
  const messages: string[] = [];
  const parser = createCursorStreamJsonLineParser((entries) => messages.push(...entries.map((entry) => entry.message)));

  for (let index = 0; index < 100; index += 1) {
    parser.push(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'abcdefghij' }] },
      })}\n`,
    );
  }
  parser.flush();

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.length, 800);
  assert.equal(messages[1]?.length, 200);
});

test('Cursor parser excludes prompts, auth source, unknown events, and tool result bodies from logs', () => {
  const messages: string[] = [];
  const parser = createCursorStreamJsonLineParser(
    (entries) => messages.push(...entries.map((entry) => entry.message)),
    {
      cwd: '/repo',
    },
  );

  const lines = [
    { type: 'system', subtype: 'init', model: 'Composer', apiKeySource: 'secret-login-source' },
    { type: 'user', message: { content: [{ type: 'text', text: 'private prompt' }] } },
    { type: 'connection', subtype: 'reconnecting', detail: 'private detail' },
    {
      type: 'tool_call',
      subtype: 'completed',
      tool_call: {
        readToolCall: {
          args: { path: '/repo/secret.txt' },
          result: { success: { content: 'top secret file body', totalLines: 1 } },
        },
      },
    },
    {
      type: 'tool_call',
      subtype: 'completed',
      tool_call: {
        terminalToolCall: {
          args: { command: 'OPENAI_API_KEY=secret-value Authorization: Bearer another-secret pnpm test\necho secret' },
          result: { error: { message: 'private terminal output' } },
        },
      },
    },
  ];
  parser.push(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  parser.flush();

  assert.deepEqual(messages, [
    'Cursor session initialized (model=Composer)',
    '[Tool] Read: secret.txt (completed)',
    '[Tool] Terminal (failed)',
  ]);
  const output = messages.join('\n');
  for (const secret of [
    'private prompt',
    'secret-login-source',
    'private detail',
    'top secret file body',
    'private terminal output',
    'secret-value',
    'another-secret',
  ]) {
    assert.equal(output.includes(secret), false);
  }
});

test('Cursor parser suppresses the final assistant event when it duplicates partial output', () => {
  const messages: string[] = [];
  const parser = createCursorStreamJsonLineParser((entries) => messages.push(...entries.map((entry) => entry.message)));
  const partialAssistant = (text: string, timestamp_ms: number) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp_ms });
  const finalAssistant = (text: string) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  parser.push(
    `${partialAssistant('TRUST', 1)}\n${partialAssistant('_', 2)}\n${partialAssistant('OK', 3)}\n${finalAssistant('TRUST_OK')}\n`,
  );
  parser.push(`${JSON.stringify({ type: 'result', is_error: false })}\n`);
  parser.flush();

  assert.deepEqual(messages, ['TRUST_OK', '[Result] Completed']);
});

test('Cursor parser emits a final assistant event once when no partial output preceded it', () => {
  const messages: string[] = [];
  const parser = createCursorStreamJsonLineParser((entries) => messages.push(...entries.map((entry) => entry.message)));

  parser.push(
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Final response' }] } })}\n`,
  );
  parser.flush();

  assert.deepEqual(messages, ['Final response']);
});

test('Cursor parser handles chunked NDJSON and flushes a trailing line', () => {
  const messages: string[] = [];
  const parser = createCursorStreamJsonLineParser((entries) => messages.push(...entries.map((entry) => entry.message)));
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Chunked output' }] },
  });
  const splitAt = Math.floor(line.length / 2);
  parser.push(line.slice(0, splitAt));
  parser.push(line.slice(splitAt));
  parser.flush();
  assert.deepEqual(messages, ['Chunked output']);
});
