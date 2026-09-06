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

// MSP model/list에는 effort 필드가 없다(muse 1.0.3, schema version 1). 대신 `--provider meta` 실행을
// 실측해 레벨을 확정했다: 카탈로그 4모델 × 8레벨 32회 실행에서 minimal~ultra 7레벨은 4모델 전부
// completed였고 `none`만 4모델 전부 exit 2로 거부됐다. 그 결과를 공급자 축으로 보완한다.
test('Muse 카탈로그 모델에 meta 공급자 실측 레벨을 보완한다', async () => {
  const fixture = await readFile(new URL('../runners/fixtures/muse-code-models.json', import.meta.url), 'utf8');
  const result = parseMuseCodeModels(fixture);
  assert.equal(result.status, 'SUCCESS');
  if (result.status !== 'SUCCESS') return;

  const metaLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  for (const model of result.values) {
    assert.deepEqual(
      (model as { supportedEffortLevels?: string[] }).supportedEffortLevels,
      metaLevels,
      `${model.value}: meta 공급자 모델은 실측 레벨을 가져야 한다`,
    );
    assert.equal(
      (model as { supportedEffortLevels?: string[] }).supportedEffortLevels?.includes('none'),
      false,
      `${model.value}: 도움말에만 있고 실행에서 거부되는 none은 싣지 않는다`,
    );
  }
});

test('meta가 아닌 공급자 모델은 레벨을 비워 미확인으로 남긴다', () => {
  const asMeta = (model: { value: string }) => model as { value: string; supportedEffortLevels?: string[] };

  // 항목별 providerId가 우선한다.
  const perRow = parseMuseCodeModels(
    JSON.stringify({
      providerId: 'meta',
      models: [
        { modelId: 'meta-model', displayLabel: 'meta-model', providerId: 'meta' },
        { modelId: 'other-model', displayLabel: 'other-model', providerId: 'self-hosted' },
      ],
    }),
  );
  assert.equal(perRow.status, 'SUCCESS');
  if (perRow.status !== 'SUCCESS') return;
  assert.equal(asMeta(perRow.values[0]).supportedEffortLevels?.length, 7);
  assert.equal(asMeta(perRow.values[1]).supportedEffortLevels, undefined);

  // 항목에 providerId가 없는 구버전 응답은 결과 전체의 providerId로 폴백한다.
  const legacy = parseMuseCodeModels(
    JSON.stringify({ providerId: 'meta', models: [{ modelId: 'legacy', displayLabel: 'legacy' }] }),
  );
  assert.equal(legacy.status, 'SUCCESS');
  if (legacy.status !== 'SUCCESS') return;
  assert.equal(asMeta(legacy.values[0]).supportedEffortLevels?.length, 7);

  // 공급자를 전혀 알 수 없으면 보완하지 않는다.
  const unknown = parseMuseCodeModels(JSON.stringify({ models: [{ modelId: 'legacy', displayLabel: 'legacy' }] }));
  assert.equal(unknown.status, 'SUCCESS');
  if (unknown.status !== 'SUCCESS') return;
  assert.equal(asMeta(unknown.values[0]).supportedEffortLevels, undefined);
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
