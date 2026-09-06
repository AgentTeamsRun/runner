import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonLineBuffer } from './json-line-buffer.js';

test('분할 행과 마지막 미개행 행을 정확히 한 번 전달한다', () => {
  const lines: string[] = [];
  const buffer = createJsonLineBuffer((line) => lines.push(line));
  buffer.push('a');
  buffer.push('\nb\nc');
  buffer.flush();
  buffer.flush();
  assert.deepEqual(lines, ['a\n', 'b\n', 'c']);
});

test('거대 행은 한 번만 유실 통지하고 다음 행에서 복구한다', () => {
  const lines: string[] = [];
  let dropped = 0;
  const buffer = createJsonLineBuffer(
    (line) => lines.push(line),
    () => {
      dropped += 1;
    },
  );
  buffer.push('x'.repeat(1024 * 1024));
  buffer.push('x');
  buffer.push('x\nvalid\n');
  buffer.flush();
  assert.equal(dropped, 1);
  assert.deepEqual(lines, ['valid\n']);
});
