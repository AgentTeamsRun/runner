import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
