import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { executeMuseCodeModelList } from './muse-code-models.js';
import { enumerateModels, parseMuseCodeModels } from './model-enumerator.js';

test('Muse model parser reads real four-model catalog without hardcoding a default', async () => {
  const fixture = await readFile(new URL('../runners/fixtures/muse-code-models.json', import.meta.url), 'utf8');
  const result = parseMuseCodeModels(fixture);
  assert.equal(result.status, 'SUCCESS');
  if (result.status !== 'SUCCESS') return;
  assert.equal(result.values.length, 4);
  assert.equal(result.values[1].label, 'muse-spark-1.3-contributor (default)');
  assert.equal(result.values[0].maxInputTokens, 1007997);
  assert.deepEqual(
    await enumerateModels('MUSE_CODE', {
      findMuseCode: async () => '/muse',
      executeMuseCode: async () => ({ stdout: fixture }),
    }),
    result,
  );
  assert.equal(parseMuseCodeModels('{"models":[null]}').status, 'FORMAT_MISMATCH');
  assert.equal(parseMuseCodeModels('{"models":[]}').status, 'EMPTY_OUTPUT');
});

for (const error of [false, true]) {
  test(`Muse MSP orders initialize/initialized/model-list and handles RPC errors (${error})`, async () => {
    const frames: { method: string }[] = [];
    let killed = false;
    const result = executeMuseCodeModelList('/muse', {
      spawn: ((_cmd: string, _args: string[], options: { windowsHide: boolean }) => {
        assert.equal(options.windowsHide, true);
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => {
            killed = true;
            return true;
          },
        });
        child.stdin.on('data', (chunk) => {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          queueMicrotask(() => {
            if (frame.method === 'initialize')
              child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
            if (frame.method === 'model/list')
              child.stdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  ...(error ? { error: { code: -32600, message: 'notInitialized' } } : { result: { models: [] } }),
                }) + '\n',
              );
          });
        });
        return child;
      }) as never,
    });
    if (error) await assert.rejects(result, /-32600: notInitialized/);
    else assert.equal((await result).stdout, '{"models":[]}');
    assert.deepEqual(
      frames.map((f) => f.method),
      ['initialize', 'initialized', 'model/list'],
    );
    assert.equal(killed, true);
  });
}

test('Muse MSP times out and kills a silent server', async () => {
  let killed = false;
  await assert.rejects(
    executeMuseCodeModelList('/muse', {
      timeoutMs: 5,
      spawn: (() =>
        Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => {
            killed = true;
            return true;
          },
        })) as never,
    }),
    /timed out/,
  );
  assert.equal(killed, true);
});
