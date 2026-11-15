import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 자식 프로세스 출력은 청크 경계에서 멀티바이트 문자가 나뉠 수 있다. 청크마다 독립적으로
// toString('utf8')을 하면 양쪽이 U+FFFD로 바뀌므로, 러너는 스트림별 StringDecoder를 써야 한다.
test('runners decode child stdout/stderr with a stream decoder, not per-chunk toString', async () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = (await readdir(dir)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  const offenders: string[] = [];
  for (const name of sources) {
    const source = await readFile(`${dir}${name}`, 'utf8');
    if (/chunk\.toString\(\s*['"]utf-?8['"]\s*\)/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
