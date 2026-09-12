import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createKimiFinalTextCapturer,
  createKimiJsonLineParser,
  parseKimiJsonLine,
  summarizeKimiTool,
} from './kimi-json-parser.js';

const fixturePath = fileURLToPath(new URL('./fixtures/kimi-events.jsonl', import.meta.url));
const cwd = '/private/tmp/x';

test('parseKimiJsonLine ignores meta events and tool bodies', async () => {
  const lines = (await readFile(fixturePath, 'utf8')).trim().split('\n');

  for (const line of lines) {
    const role = (JSON.parse(line) as { role?: string }).role;
    if (role === 'meta' || role === 'tool') {
      assert.deepEqual(parseKimiJsonLine(line, { cwd }), []);
    }
  }
});

test('parseKimiJsonLine summarizes tool calls without file bodies or command output', async () => {
  const lines = (await readFile(fixturePath, 'utf8')).trim().split('\n');
  const readCall = lines.find((line) => line.includes('"Read_0_'));
  const writeCall = lines.find((line) => line.includes('"Write_1_'));

  assert.ok(readCall);
  assert.ok(writeCall);
  assert.deepEqual(parseKimiJsonLine(readCall, { cwd }), [
    { level: 'INFO', category: 'TOOL', toolName: 'Read', message: '[Tool] Read: input.txt' },
  ]);
  assert.deepEqual(parseKimiJsonLine(writeCall, { cwd }), [
    { level: 'INFO', category: 'TOOL', toolName: 'Write', message: '[Tool] Write: output.txt' },
  ]);

  const messages = [readCall, writeCall].flatMap((line) =>
    parseKimiJsonLine(line, { cwd }).map((entry) => entry.message),
  );
  assert.ok(!messages.join('\n').includes('hello kimi'));
});

test('createKimiJsonLineParser replays the measured fixture across chunk boundaries', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const replay = async (chunks: string[]): Promise<string[]> => {
    const entries: string[] = [];
    const parser = createKimiJsonLineParser((batch) => entries.push(...batch.map((entry) => entry.message)), {
      cwd,
    });
    for (const chunk of chunks) parser.push(chunk);
    parser.flush();
    return entries;
  };

  const expected = ['[Tool] Read: input.txt', '[Tool] Write: output.txt', 'Done.'];
  assert.deepEqual(await replay([fixture]), expected);

  const firstCut = Math.floor(fixture.length / 3);
  const secondCut = Math.floor((fixture.length * 2) / 3);
  assert.deepEqual(
    await replay([fixture.slice(0, firstCut), fixture.slice(firstCut, secondCut), fixture.slice(secondCut)]),
    expected,
  );

  assert.deepEqual(await replay([`${fixture.trimEnd()}\nnot json\n`]), expected);
  assert.ok(!(await replay([fixture])).join('\n').includes('hello kimi'));
});

test('createKimiFinalTextCapturer keeps the last assistant message', async () => {
  const fixture = await readFile(fixturePath, 'utf8');
  const capturer = createKimiFinalTextCapturer();
  const cut = Math.floor(fixture.length / 2);
  capturer.push(fixture.slice(0, cut));
  capturer.push(fixture.slice(cut));
  capturer.flush();

  assert.equal(
    capturer.get(),
    'Done. `input.txt` contained "hello kimi", and I wrote that single line to `output.txt`.',
  );
});

test('summarizeKimiTool keeps only whitelisted arguments', () => {
  assert.equal(summarizeKimiTool('Read', { path: '/private/tmp/x/note.txt' }, cwd), 'Read: note.txt');
  assert.equal(summarizeKimiTool('Bash', { command: '  echo hi\nrm -rf /  ' }, cwd), 'Bash: echo hi');
  assert.equal(summarizeKimiTool('Write', { path: 'out.txt', content: 'secret body' }, cwd), 'Write: out.txt');
  assert.equal(summarizeKimiTool('Mystery', { alpha: '1', beta: '2' }, cwd), 'Mystery(alpha,beta)');
  assert.equal(summarizeKimiTool('Mystery', undefined, cwd), 'Mystery');
});

test('parseKimiJsonLine drops malformed and out-of-contract lines', () => {
  assert.deepEqual(parseKimiJsonLine('', { cwd }), []);
  assert.deepEqual(parseKimiJsonLine('   ', { cwd }), []);
  assert.deepEqual(parseKimiJsonLine('not json', { cwd }), []);
  assert.deepEqual(parseKimiJsonLine('{"role":"assistant"}', { cwd }), []);
  assert.deepEqual(parseKimiJsonLine('{"role":"unknown","content":"hi"}', { cwd }), []);
  assert.deepEqual(
    parseKimiJsonLine('{"role":"assistant","tool_calls":[{"function":{"name":"Read","arguments":"{bad json"}}]}', {
      cwd,
    }),
    [{ level: 'INFO', category: 'TOOL', toolName: 'Read', message: '[Tool] Read' }],
  );
});
