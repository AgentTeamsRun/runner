import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenCodeOutputCapture, filterPowerShellClixmlNoise, isPowerShellClixmlNoise } from './opencode.js';

test('isPowerShellClixmlNoise flags PowerShell CLIXML preamble', () => {
  assert.equal(isPowerShellClixmlNoise('#< CLIXML'), true);
  assert.equal(isPowerShellClixmlNoise('#< CLIXML\n<Objs Version="1.1.0.1">'), true);
});

test('isPowerShellClixmlNoise flags serialized progress objects', () => {
  assert.equal(
    isPowerShellClixmlNoise(
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" /></Objs>',
    ),
    true,
  );
});

test('isPowerShellClixmlNoise tolerates leading whitespace', () => {
  assert.equal(isPowerShellClixmlNoise('  \n#< CLIXML'), true);
  assert.equal(isPowerShellClixmlNoise('\r\n<Objs Version="1.1.0.1">'), true);
});

test('isPowerShellClixmlNoise keeps meaningful agent output', () => {
  // 실제 에이전트 출력(폴백 히스토리로 보존되어야 하는 내용)은 노이즈로 분류되면 안 된다.
  assert.equal(isPowerShellClixmlNoise('→ Read package.json'), false);
  assert.equal(isPowerShellClixmlNoise('✗ Read .env failed'), false);
  assert.equal(isPowerShellClixmlNoise('Here is how to set up the dev environment...'), false);
  assert.equal(isPowerShellClixmlNoise(''), false);
});

test('filterPowerShellClixmlNoise drops split CLIXML documents across chunks', () => {
  const state = { isDiscardingClixml: false };

  assert.equal(filterPowerShellClixmlNoise('#< CLIXML\r\n<Objs Version="1.1.0.1"', state), '');
  assert.equal(
    filterPowerShellClixmlNoise('><Obj S="progress" /></Objs>\nMeaningful stderr', state),
    '\nMeaningful stderr',
  );
});

test('createOpenCodeOutputCapture keeps stdout and meaningful stderr fallback output', () => {
  const capture = createOpenCodeOutputCapture();

  capture.appendStdout('stdout text\n');
  capture.appendStderr('stderr agent text\n');

  assert.equal(capture.toResultOutputText(), 'stdout text\nstderr agent text');
});

test('createOpenCodeOutputCapture excludes CLIXML stderr from fallback output', () => {
  const capture = createOpenCodeOutputCapture();

  capture.appendStderr('#< CLIXML\r\n<Objs Version="1.1.0.1"');
  capture.appendStderr('><Obj S="progress" /></Objs>');
  capture.appendStderr('\nactual agent output');

  assert.equal(capture.toResultOutputText(), 'actual agent output');
});

import { buildOpenCodeRunArgs, toOpenCodePowerShellEncodedCommand } from './opencode.js';

test('buildOpenCodeRunArgs forwards the confirmed effort level exactly once via --variant', () => {
  const builder = buildOpenCodeRunArgs;
  assert.equal(typeof builder, 'function', 'opencode.ts must export buildOpenCodeRunArgs(model, effort)');
  const args = builder('opencode/muse-spark-1.3-contributor-free', 'high');
  assert.deepEqual(args.slice(0, 3), ['run', '--format', 'json']);
  assert.equal(args.filter((arg) => arg === '--variant').length, 1, 'variant flag must be present exactly once');
  assert.equal(args[args.indexOf('--variant') + 1], 'high');
  assert.equal(args.includes('--thinking'), false, '--thinking is a display toggle, not an effort control');
});

test('buildOpenCodeRunArgs omits --variant when effort is missing or blank', () => {
  const builder = buildOpenCodeRunArgs;
  assert.equal(typeof builder, 'function', 'opencode.ts must export buildOpenCodeRunArgs(model, effort)');
  for (const effort of [undefined, null, '', '   ']) {
    assert.equal(builder('opencode/big-pickle', effort).includes('--variant'), false);
  }
});

test('toOpenCodePowerShellEncodedCommand forwards the confirmed effort level on Windows', () => {
  const builder = toOpenCodePowerShellEncodedCommand;
  assert.equal(typeof builder, 'function', 'opencode.ts must export toOpenCodePowerShellEncodedCommand');
  const decoded = Buffer.from(
    builder('C:/opencode.exe', 'hello', 'opencode/muse-spark-1.3-contributor-free', 'high'),
    'base64',
  ).toString('utf16le');
  assert.ok(decoded.includes("'--variant' 'high'"), decoded);
});
