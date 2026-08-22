import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_RUNNER_NAME, buildHelpText, resolveInvokedName } from './help.js';

test('resolveInvokedName keeps whitelisted invocation names', () => {
  assert.equal(resolveInvokedName('agr'), 'agr');
  assert.equal(resolveInvokedName('agentrunner'), CANONICAL_RUNNER_NAME);
});

test('resolveInvokedName falls back to the canonical name for anything else', () => {
  assert.equal(resolveInvokedName('index.js'), CANONICAL_RUNNER_NAME);
  assert.equal(resolveInvokedName(''), CANONICAL_RUNNER_NAME);
  assert.equal(resolveInvokedName('agentrunner-start'), CANONICAL_RUNNER_NAME);
});

test('resolveInvokedName falls back for shim entry points that pass the real script path', () => {
  // Windows `agr.cmd`/`agr.ps1`와 pnpm 전역 래퍼는 심링크가 아니라 `node "<...>\\dist\\index.js"`를
  // 실행하므로 argv[1]에는 항상 진입 스크립트가 들어온다. 폴백이 의도된 동작임을 고정한다.
  assert.equal(
    resolveInvokedName('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agentteams\\runner\\dist\\index.js'),
    CANONICAL_RUNNER_NAME,
  );
  assert.equal(buildHelpText('index.js').split('\n')[0], 'Usage: agentrunner [command] [options]');
});

test('resolveInvokedName reads process.argv[1] by default', () => {
  const original = process.argv[1];
  try {
    process.argv[1] = '/usr/local/bin/agr';
    assert.equal(resolveInvokedName(), 'agr');
    process.argv[1] = '/usr/local/lib/node_modules/@agentteams/runner/dist/index.js';
    assert.equal(resolveInvokedName(), CANONICAL_RUNNER_NAME);
  } finally {
    process.argv[1] = original;
  }
});

test('buildHelpText renders the usage line with the invoked name', () => {
  assert.equal(buildHelpText('agr').split('\n')[0], 'Usage: agr [command] [options]');
  assert.equal(buildHelpText('agentrunner').split('\n')[0], 'Usage: agentrunner [command] [options]');
  assert.equal(buildHelpText('whatever').split('\n')[0], 'Usage: agentrunner [command] [options]');
});

test('buildHelpText only swaps the usage name, leaving the body untouched', () => {
  const canonical = buildHelpText('agentrunner');
  const alias = buildHelpText('agr');

  assert.equal(alias.replace('Usage: agr ', 'Usage: agentrunner '), canonical);
  assert.match(canonical, /\n {2}cleanup --path <path> {7}Purge expired runner log\/history files\n/u);
});
