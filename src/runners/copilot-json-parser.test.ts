import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createCopilotFinalTextCapturer,
  createCopilotJsonLineParser,
  parseCopilotJsonLine,
  summarizeCopilotTool,
} from './copilot-json-parser.js';

const fixturePath = fileURLToPath(new URL('./fixtures/copilot-events.jsonl', import.meta.url));
const cwd = '/private/tmp/agentteams-copilot-probe.B3wIet';

test('summarizeCopilotTool only exposes allowlisted path or command fields', () => {
  assert.equal(
    summarizeCopilotTool('create', { path: `${cwd}/greet.txt`, file_text: 'HELLO WORLD' }, cwd),
    'create: greet.txt',
  );
  assert.equal(summarizeCopilotTool('shell', { command: `cd ${cwd}\necho done` }, cwd), 'shell: cd .');
  assert.equal(
    summarizeCopilotTool('custom', { alpha: 1, beta: 2, secretBody: 'hidden' }),
    'custom(alpha,beta,secretBody)',
  );
});

test('measured Copilot fixture suppresses ephemeral noise and file or result bodies', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const lines = fixture.trim().split('\n');
  const entries = lines.flatMap((line) => parseCopilotJsonLine(line, { cwd }));
  const messages = entries.map((entry) => entry.message);

  assert.equal(lines.length, 136);
  assert.equal(lines.filter((line) => line.includes('"ephemeral":true')).length, 119);
  assert.ok(entries.length < 20);
  assert.ok(messages.includes('[Tool] view: note.txt'));
  assert.ok(messages.includes('[Tool] create: greet.txt'));
  assert.ok(messages.some((message) => message.startsWith('[Result] Completed in 36s')));
  assert.ok(entries.some((entry) => entry.category === 'TOOL' && entry.toolName === 'create'));
  assert.equal(entries.at(-1)?.category, 'RESULT');
  assert.ok(!messages.join('\n').includes('HELLO WORLD'));
  assert.ok(!messages.join('\n').includes('reasoningOpaque'));
  assert.ok(!messages.join('\n').includes('detailedContent'));
});

test('createCopilotJsonLineParser handles measured output split mid-line', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const entries: string[] = [];
  const parser = createCopilotJsonLineParser((batch) => entries.push(...batch.map((entry) => entry.message)), { cwd });
  const cut = Math.floor(fixture.length / 2);
  parser.push(fixture.slice(0, cut));
  parser.push(fixture.slice(cut));
  parser.flush();

  assert.ok(entries.includes('[Tool] create: greet.txt'));
  assert.ok(entries.at(-1)?.startsWith('[Result] Completed'));
});

test('createCopilotFinalTextCapturer retains the final non-empty assistant message', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const capturer = createCopilotFinalTextCapturer();
  const cut = Math.floor(fixture.length / 2);
  capturer.push(fixture.slice(0, cut));
  capturer.push(fixture.slice(cut));
  capturer.flush();

  assert.equal(capturer.get(), 'Completed: note.txt read and greet.txt created with uppercase contents.');
});

test('parseCopilotJsonLine reports failures without exposing result payloads', () => {
  const line = JSON.stringify({
    type: 'tool.execution_complete',
    data: { toolName: 'create', success: false, result: { content: 'SECRET BODY' } },
  });
  assert.deepEqual(parseCopilotJsonLine(line), [
    { level: 'WARN', category: 'TOOL', toolName: 'create', message: '[Tool] create (failed)' },
  ]);
});
