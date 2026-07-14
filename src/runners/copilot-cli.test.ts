import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopilotCliArgs, toPowerShellEncodedCommand } from './copilot-cli.js';

test('buildCopilotCliArgs sends the prompt inline and enables unattended allow-all execution', () => {
  assert.deepEqual(buildCopilotCliArgs('hello', null), ['-p', 'hello', '--allow-all', '--no-ask-user']);
});

test('buildCopilotCliArgs leaves the client default model to Copilot CLI', () => {
  assert.deepEqual(buildCopilotCliArgs('hello', 'default'), ['-p', 'hello', '--allow-all', '--no-ask-user']);
});

test('buildCopilotCliArgs appends a requested model', () => {
  assert.deepEqual(buildCopilotCliArgs('hello', 'gpt-5'), [
    '-p',
    'hello',
    '--allow-all',
    '--no-ask-user',
    '--model',
    'gpt-5',
  ]);
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

test('toPowerShellEncodedCommand reads the prompt from a file and preserves unattended arguments', () => {
  const promptFilePath = 'C:/repo/.agentteams/runner/tmp/trigger-123.prompt.txt';
  const script = decodePowerShellCommand(toPowerShellEncodedCommand('C:/copilot.cmd', promptFilePath, 'gpt-5'));
  assert.match(script, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(script, /'--allow-all' '--no-ask-user' '--model' 'gpt-5'/);
  assert.ok(script.includes(promptFilePath));
});

test('toPowerShellEncodedCommand omits the default model', () => {
  const script = decodePowerShellCommand(
    toPowerShellEncodedCommand('C:/copilot.cmd', 'C:/repo/.agentteams/runner/tmp/trigger-456.prompt.txt', 'default'),
  );
  assert.match(script, /'--allow-all' '--no-ask-user'/);
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
