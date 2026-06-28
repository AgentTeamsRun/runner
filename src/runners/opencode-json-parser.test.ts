import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenCodeFinalTextCapturer,
  createOpenCodeJsonLineParser,
  extractFinalTextFromOpenCodeJson,
  parseOpenCodeJsonLine,
  summarizeOpenCodeTool,
} from './opencode-json-parser.js';

const cwd = '/Users/justin/Project/Me/AgentTeams';

// Event envelopes mirror the real `opencode run --format json` output:
// { type, timestamp, sessionID, part: { type, ... } }
const textEvent = (text: string, messageID = 'msg_1') =>
  JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'ses_1', part: { type: 'text', text, messageID } });
const toolEvent = (tool: string, input: Record<string, unknown>, status: string) =>
  JSON.stringify({
    type: 'tool',
    timestamp: 1,
    sessionID: 'ses_1',
    part: { type: 'tool', tool, state: { status, input } },
  });

test('summarizeOpenCodeTool renders readable summaries with opencode input keys', () => {
  assert.equal(summarizeOpenCodeTool('bash', { command: 'git status\necho done' }), 'bash: git status');
  assert.equal(summarizeOpenCodeTool('read', { filePath: `${cwd}/web/src/foo.ts` }, cwd), 'read: web/src/foo.ts');
  assert.equal(
    summarizeOpenCodeTool('edit', { filePath: `${cwd}/daemon/src/index.ts` }, cwd),
    'edit: daemon/src/index.ts',
  );
  assert.equal(summarizeOpenCodeTool('grep', { pattern: 'foo', path: `${cwd}/src` }, cwd), 'grep: "foo" in src');
  assert.equal(summarizeOpenCodeTool('webfetch', { url: 'https://example.com' }), 'webfetch: https://example.com');
  assert.equal(summarizeOpenCodeTool('custom', { alpha: 1, beta: 2, gamma: 3, delta: 4 }), 'custom(alpha,beta,gamma)');
  assert.equal(summarizeOpenCodeTool('custom', {}), 'custom');
});

test('parseOpenCodeJsonLine reduces assistant text to first sentence', () => {
  const line = textEvent('Now wire the refetch into the controller. Next steps follow.');
  assert.deepEqual(parseOpenCodeJsonLine(line), [
    { level: 'INFO', message: 'Now wire the refetch into the controller.' },
  ]);
});

test('parseOpenCodeJsonLine only surfaces terminal tool state and flags errors', () => {
  const cmd = { command: 'ls dist' };
  assert.deepEqual(parseOpenCodeJsonLine(toolEvent('bash', cmd, 'running')), []);
  assert.deepEqual(parseOpenCodeJsonLine(toolEvent('bash', cmd, 'completed')), [
    { level: 'INFO', message: '[Tool] bash: ls dist' },
  ]);
  assert.deepEqual(parseOpenCodeJsonLine(toolEvent('bash', cmd, 'error')), [
    { level: 'WARN', message: '[Tool] bash: ls dist (error)' },
  ]);
});

test('parseOpenCodeJsonLine summarizes patch and step-finish, hides reasoning by default', () => {
  const patch = JSON.stringify({
    type: 'patch',
    part: { type: 'patch', files: [`${cwd}/api/src/a.ts`, `${cwd}/api/src/b.ts`] },
  });
  assert.deepEqual(parseOpenCodeJsonLine(patch, { cwd }), [
    { level: 'INFO', message: '[Patch] api/src/a.ts, api/src/b.ts' },
  ]);

  const step = JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'stop', tokens: { output: 23 }, cost: 0.00266898 },
  });
  assert.deepEqual(parseOpenCodeJsonLine(step), [
    { level: 'INFO', message: '[Step finished: stop, 23 out tok, $0.0027]' },
  ]);

  const reasoning = JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: 'hidden by default' } });
  assert.deepEqual(parseOpenCodeJsonLine(reasoning), []);
  assert.deepEqual(parseOpenCodeJsonLine(reasoning, { verbose: true }), [
    { level: 'INFO', message: '[Thinking] hidden by default' },
  ]);
});

test('parseOpenCodeJsonLine returns empty for malformed, empty, or partless input', () => {
  assert.deepEqual(parseOpenCodeJsonLine(''), []);
  assert.deepEqual(parseOpenCodeJsonLine('not json'), []);
  assert.deepEqual(parseOpenCodeJsonLine('{"type":"text"}'), []); // no part
  assert.deepEqual(parseOpenCodeJsonLine(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } })), []);
});

test('createOpenCodeJsonLineParser handles chunked input', () => {
  const collected: string[] = [];
  const parser = createOpenCodeJsonLineParser((entries) => collected.push(...entries.map((e) => e.message)), { cwd });

  const a = toolEvent('read', { filePath: `${cwd}/a.ts` }, 'completed');
  const b = textEvent('All done.');
  const half = Math.floor(a.length / 2);
  parser.push(a.slice(0, half));
  parser.push(`${a.slice(half)}\n${b}\n`);

  assert.deepEqual(collected, ['[Tool] read: a.ts', 'All done.']);
});

test('extractFinalTextFromOpenCodeJson returns the last assistant message text', () => {
  const transcript = [
    textEvent('first pass thinking out loud', 'msg_1'),
    toolEvent('bash', { command: 'ls' }, 'completed'),
    textEvent('The final ', 'msg_2'),
    textEvent('answer.', 'msg_2'),
  ].join('\n');

  assert.equal(extractFinalTextFromOpenCodeJson(transcript), 'The final answer.');
});

test('extractFinalTextFromOpenCodeJson falls back to raw input when no text part exists', () => {
  const raw = JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } });
  assert.equal(extractFinalTextFromOpenCodeJson(raw), raw);
});

test('createOpenCodeFinalTextCapturer retains final text across chunks and survives a head cap', () => {
  const capturer = createOpenCodeFinalTextCapturer();
  assert.equal(capturer.get(), null);

  // Early (head) output, then the closing assistant message split mid-line across pushes.
  capturer.push(`${textEvent('early scratch', 'msg_1')}\n`);
  const closing = `${textEvent('Clean final ', 'msg_2')}\n${textEvent('summary.', 'msg_2')}`;
  const half = Math.floor(closing.length / 2);
  capturer.push(closing.slice(0, half));
  capturer.push(closing.slice(half));
  capturer.flush();

  assert.equal(capturer.get(), 'Clean final summary.');
});
