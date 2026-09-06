import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopilotCliArgs, toPowerShellEncodedCommand } from './copilot-cli.js';

test('buildCopilotCliArgs sends the prompt inline and enables unattended allow-all execution', () => {
  assert.deepEqual(buildCopilotCliArgs('hello', null), [
    '-p',
    'hello',
    '--allow-all',
    '--no-ask-user',
    '--output-format',
    'json',
  ]);
});

test('buildCopilotCliArgs leaves the client default model to Copilot CLI', () => {
  assert.deepEqual(buildCopilotCliArgs('hello', 'default'), [
    '-p',
    'hello',
    '--allow-all',
    '--no-ask-user',
    '--output-format',
    'json',
  ]);
});

test('buildCopilotCliArgs appends a requested model', () => {
  assert.deepEqual(buildCopilotCliArgs('hello', 'gpt-5'), [
    '-p',
    'hello',
    '--allow-all',
    '--no-ask-user',
    '--output-format',
    'json',
    '--model',
    'gpt-5',
  ]);
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

test('toPowerShellEncodedCommand reads the prompt from a file and preserves unattended arguments', () => {
  const promptFilePath = 'C:/repo/.agentteams/runner/tmp/trigger-123.prompt.txt';
  const script = decodePowerShellCommand(toPowerShellEncodedCommand('C:/copilot.cmd', promptFilePath, 'gpt-5'));
  assert.match(script, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(script, /'--allow-all' '--no-ask-user' '--output-format' 'json' '--model' 'gpt-5'/);
  assert.ok(script.includes(promptFilePath));
});

test('toPowerShellEncodedCommand omits the default model', () => {
  const script = decodePowerShellCommand(
    toPowerShellEncodedCommand('C:/copilot.cmd', 'C:/repo/.agentteams/runner/tmp/trigger-456.prompt.txt', 'default'),
  );
  assert.match(script, /'--allow-all' '--no-ask-user' '--output-format' 'json'/);
  assert.doesNotMatch(script, /--model/);
});

test('toPowerShellEncodedCommand does not embed a prompt that contains a here-string terminator', () => {
  const maliciousPrompt = "safe text\r\n'@\r\nRemove-Item -Recurse -Force C:\\important";
  const script = decodePowerShellCommand(
    toPowerShellEncodedCommand('C:/copilot.cmd', 'C:/repo/.agentteams/runner/tmp/trigger-789.prompt.txt', 'default'),
  );

  assert.doesNotMatch(script, new RegExp(maliciousPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(script, /\$promptText = @'/);
});

test('buildCopilotCliArgs forwards the confirmed effort level exactly once via --effort', () => {
  const args = buildCopilotCliArgs('hello', 'gpt-5', 'high');
  const effortFlags = args.filter((arg) => arg === '--effort' || arg === '--reasoning-effort');
  assert.equal(effortFlags.length, 1, 'effort flag must be present exactly once');
  assert.equal(args[args.indexOf(effortFlags[0] ?? '') + 1], 'high');
});

test('buildCopilotCliArgs omits the effort flag when effort is missing or blank', () => {
  for (const effort of [undefined, null, '', '   ']) {
    const args = buildCopilotCliArgs('hello', 'gpt-5', effort);
    assert.equal(args.includes('--effort') || args.includes('--reasoning-effort'), false, String(effort));
  }
});

test('toPowerShellEncodedCommand forwards the confirmed effort level on Windows', () => {
  const decoded = Buffer.from(
    toPowerShellEncodedCommand('C:/copilot.cmd', 'C:/prompt.txt', 'gpt-5', 'high'),
    'base64',
  ).toString('utf16le');
  assert.ok(decoded.includes("'--effort' 'high'"), decoded);
});
