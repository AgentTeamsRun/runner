import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createOmpJsonLineParser,
  createOmpResultCapturer,
  parseOmpJsonLine,
  summarizeOmpTool,
} from './omp-json-parser.js';
import type { ParsedLogEntry } from './stream-json-parser.js';

const successFixturePath = fileURLToPath(new URL('./fixtures/omp-events.jsonl', import.meta.url));
const errorFixturePath = fileURLToPath(new URL('./fixtures/omp-events-error.jsonl', import.meta.url));

const readFixture = (path: string): Promise<string> => readFile(path, 'utf8');

const collectEntries = (chunks: string[]): ParsedLogEntry[] => {
  const entries: ParsedLogEntry[] = [];
  const parser = createOmpJsonLineParser((batch) => entries.push(...batch));
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  parser.flush();
  return entries;
};

const splitEvery = (text: string, size: number): string[] => {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
};

test('parseOmpJsonLine maps the session preamble to SYSTEM entries', () => {
  const session = parseOmpJsonLine('{"type":"session","version":3,"id":"01a0","cwd":"/repo"}');
  assert.deepEqual(session, [{ level: 'INFO', category: 'SYSTEM', message: '[Session started]' }]);
  assert.equal(parseOmpJsonLine('{"type":"agent_start"}')[0]?.category, 'SYSTEM');
  assert.equal(parseOmpJsonLine('{"type":"turn_start"}')[0]?.category, 'SYSTEM');
});

test('parseOmpJsonLine emits one entry per completed block and nothing for deltas', () => {
  assert.deepEqual(parseOmpJsonLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_start"}}'), []);
  assert.deepEqual(
    parseOmpJsonLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"**Plan"}}'),
    [],
  );
  assert.deepEqual(
    parseOmpJsonLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"**Plan**"}}'),
    [{ level: 'INFO', category: 'THINKING', message: '[Thinking] **Plan**' }],
  );

  assert.deepEqual(
    parseOmpJsonLine('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"VER"}}'),
    [],
  );
  assert.deepEqual(
    parseOmpJsonLine(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"VERIFIED alpha"}}',
    ),
    [{ level: 'INFO', category: 'TEXT', message: 'VERIFIED alpha' }],
  );
});

test('parseOmpJsonLine logs tool executions with the tool name and summarized args', () => {
  const entries = parseOmpJsonLine(
    '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"write","args":{"path":"/repo/alpha.txt","content":"ALPHA"}}',
    { cwd: '/repo' },
  );
  assert.deepEqual(entries, [
    { level: 'INFO', category: 'TOOL', toolName: 'write', message: '[Tool] write: alpha.txt' },
  ]);

  // A successful execution was already logged at start; only failures add a second line.
  assert.deepEqual(parseOmpJsonLine('{"type":"tool_execution_end","toolName":"write","result":{"content":[]}}'), []);
  assert.deepEqual(
    parseOmpJsonLine(
      '{"type":"tool_execution_end","toolName":"write","result":{"content":[],"details":{}},"isError":true}',
    ),
    [{ level: 'WARN', category: 'TOOL', toolName: 'write', message: '[Tool] write (error)' }],
  );
});

test('parseOmpJsonLine ignores unknown types and unparsable lines', () => {
  // `notice` is emitted once at session start by omp/18.0.6 and is not in the documented type list.
  assert.deepEqual(parseOmpJsonLine('{"type":"notice","level":"info","message":"xd:// mounted","source":"xdev"}'), []);
  assert.deepEqual(parseOmpJsonLine('{"type":"agent_end","messages":[]}'), []);
  assert.deepEqual(parseOmpJsonLine('not json at all'), []);
  assert.deepEqual(parseOmpJsonLine('   '), []);
});

test('summarizeOmpTool prefers command, then path, then pattern, then arg keys', () => {
  assert.equal(summarizeOmpTool('bash', { command: 'ls -al\ncd /tmp' }), 'bash: ls -al');
  assert.equal(summarizeOmpTool('read', { path: '/repo/src/index.ts' }, '/repo'), 'read: src/index.ts');
  assert.equal(summarizeOmpTool('grep', { pattern: 'idleTimeout' }), 'grep: "idleTimeout"');
  assert.equal(summarizeOmpTool('todo', { op: 'init', list: [] }), 'todo(op,list)');
  assert.equal(summarizeOmpTool('noargs', undefined), 'noargs');
});

test('the success fixture refines into THINKING, TOOL, and TEXT entries', async () => {
  const fixture = await readFixture(successFixturePath);
  const entries = collectEntries([fixture]);

  const categories = entries.map((entry) => entry.category);
  assert.equal(categories.includes('SYSTEM'), true);
  assert.equal(categories.includes('THINKING'), true);
  assert.equal(categories.includes('TOOL'), true);
  assert.equal(categories.includes('TEXT'), true);
  assert.equal(
    entries.some((entry) => entry.message.trimStart().startsWith('{')),
    false,
    'raw NDJSON must never be forwarded as a log message',
  );

  assert.deepEqual(
    entries.filter((entry) => entry.category === 'TOOL').map((entry) => entry.toolName),
    ['todo', 'write', 'read'],
  );
  assert.equal(entries.at(-1)?.category, 'TEXT');
  assert.equal(entries.at(-1)?.message, 'VERIFIED alpha beta gamma');
});

test('chunk boundaries in the middle of a line do not change the parsed entries', async () => {
  const fixture = await readFixture(successFixturePath);
  const whole = collectEntries([fixture]);

  for (const size of [1, 7, 64, 997]) {
    assert.deepEqual(collectEntries(splitEvery(fixture, size)), whole, `chunk size ${size} changed the entries`);
  }
});

test('CRLF line endings produce the same entries as LF', async () => {
  const fixture = await readFixture(successFixturePath);
  const crlf = fixture.split('\n').join('\r\n');

  assert.deepEqual(collectEntries([crlf]), collectEntries([fixture]));
  assert.deepEqual(collectEntries(splitEvery(crlf, 13)), collectEntries([fixture]));
});

test('a trailing line without a newline is parsed on flush', () => {
  const entries: ParsedLogEntry[] = [];
  const parser = createOmpJsonLineParser((batch) => entries.push(...batch));
  parser.push('{"type":"agent_start"}\n{"type":"turn_start"}');
  assert.equal(entries.length, 1);
  parser.flush();
  assert.equal(entries.length, 2);
});

test('the result capturer returns the final assistant text and no failure on success', async () => {
  const fixture = await readFixture(successFixturePath);
  const capturer = createOmpResultCapturer();
  for (const chunk of splitEvery(fixture, 11)) {
    capturer.push(chunk);
  }
  capturer.flush();

  assert.equal(capturer.getFinalText(), 'VERIFIED alpha beta gamma');
  assert.equal(capturer.getFailureMessage(), null);
});

test('a successful terminal event clears an earlier turn failure', () => {
  const capturer = createOmpResultCapturer();
  capturer.push(
    [
      JSON.stringify({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorStatus: 429,
          errorMessage: 'Rate limited',
        },
      }),
      JSON.stringify({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered answer' }],
          stopReason: 'stop',
        },
      }),
    ].join('\n'),
  );
  capturer.flush();

  assert.equal(capturer.getFinalText(), 'Recovered answer');
  assert.equal(capturer.getFailureMessage(), null);
});

test('the result capturer keeps completed streamed text before a terminal event', () => {
  const capturer = createOmpResultCapturer();
  capturer.push(
    `${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', content: 'Partial but useful answer' },
    })}\n`,
  );
  capturer.flush();

  assert.equal(capturer.getFinalText(), null);
  assert.equal(capturer.getStreamedTextFallback(), 'Partial but useful answer');
});

test('the result capturer ignores the echoed user prompt and tool results', async () => {
  const fixture = await readFixture(successFixturePath);
  const capturer = createOmpResultCapturer();
  capturer.push(fixture);
  capturer.flush();

  const finalText = capturer.getFinalText() ?? '';
  assert.equal(finalText.includes('<file name='), false, 'the echoed user prompt must not become the answer');
  assert.equal(finalText.includes('Remaining items'), false, 'a tool result must not become the answer');
});

test('the 401 fixture yields the provider failure cause with status and original message', async () => {
  const fixture = await readFixture(errorFixturePath);
  const capturer = createOmpResultCapturer();
  for (const chunk of splitEvery(fixture, 23)) {
    capturer.push(chunk);
  }
  capturer.flush();

  const failure = capturer.getFailureMessage() ?? '';
  assert.match(failure, /401/);
  assert.match(failure, /Incorrect API key provided: sk-bogus/);
  assert.equal(capturer.getFinalText(), null, 'a failed run has no assistant answer');
});

test('the failure cause survives CRLF output', async () => {
  const fixture = await readFixture(errorFixturePath);
  const capturer = createOmpResultCapturer();
  capturer.push(fixture.split('\n').join('\r\n'));
  capturer.flush();

  assert.match(capturer.getFailureMessage() ?? '', /401 Incorrect API key provided/);
});
