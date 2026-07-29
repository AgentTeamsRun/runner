import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodexFinalTextCapturer, createCodexJsonLineParser, parseCodexJsonLine } from './codex-json-parser.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex-events.jsonl', import.meta.url));
const cwd = '/private/tmp/x';

test('parseCodexJsonLine hides command output and only emits terminal command state', async () => {
  const lines = (await readFile(fixturePath, 'utf8')).trim().split('\n');
  const started = lines.find((line) => line.includes('"item.started"') && line.includes('"command_execution"'));
  const completed = lines.find((line) => line.includes('"item.completed"') && line.includes('"command_execution"'));

  assert.ok(started);
  assert.ok(completed);
  assert.deepEqual(parseCodexJsonLine(started, { cwd }), []);
  const entries = parseCodexJsonLine(completed, { cwd });
  assert.deepEqual(entries, [{ level: 'INFO', message: "[Tool] Bash: sed -n '1,200p' note.txt" }]);
  assert.ok(!entries.some((entry) => entry.message.includes('hello world')));
});

test('parseCodexJsonLine summarizes completed file changes without file contents', async () => {
  const line = (await readFile(fixturePath, 'utf8'))
    .trim()
    .split('\n')
    .find((entry) => entry.includes('"item.completed"') && entry.includes('"file_change"'));

  assert.ok(line);
  assert.deepEqual(parseCodexJsonLine(line, { cwd }), [
    { level: 'INFO', message: '[Tool] File change: greet.txt (add)' },
  ]);
});

test('createCodexJsonLineParser replays the measured fixture across chunk boundaries', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const entries: string[] = [];
  const parser = createCodexJsonLineParser((batch) => entries.push(...batch.map((entry) => entry.message)), { cwd });
  const firstCut = Math.floor(fixture.length / 3);
  const secondCut = Math.floor((fixture.length * 2) / 3);

  parser.push(fixture.slice(0, firstCut));
  parser.push(fixture.slice(firstCut, secondCut));
  parser.push(fixture.slice(secondCut));
  parser.flush();

  assert.deepEqual(entries, [
    "I'll read the note, search the directory, and write the uppercase copy.",
    "[Tool] Bash: sed -n '1,200p' note.txt",
    '[Tool] File change: greet.txt (add)',
    'Created greet.txt containing `HELLO WORLD`.',
    '[Result] Completed',
  ]);
  assert.ok(!entries.join('\n').includes('hello world'));
});

test('createCodexFinalTextCapturer keeps the last completed assistant message', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const capturer = createCodexFinalTextCapturer();
  const cut = Math.floor(fixture.length / 2);
  capturer.push(fixture.slice(0, cut));
  capturer.push(fixture.slice(cut));
  capturer.flush();

  assert.equal(capturer.get(), 'Created greet.txt containing `HELLO WORLD`.');
});

test('parseCodexJsonLine hides reasoning unless verbose and handles failure events', () => {
  const reasoning = JSON.stringify({
    type: 'item.completed',
    item: { type: 'reasoning', text: 'Inspect the repository before editing.' },
  });
  assert.deepEqual(parseCodexJsonLine(reasoning), []);
  assert.deepEqual(parseCodexJsonLine(reasoning, { verbose: true }), [
    { level: 'INFO', message: '[Thinking] Inspect the repository before editing.' },
  ]);
  assert.deepEqual(parseCodexJsonLine(JSON.stringify({ type: 'turn.failed', error: { message: 'model failed' } })), [
    { level: 'WARN', message: '[Result] Failed: model failed' },
  ]);
});
