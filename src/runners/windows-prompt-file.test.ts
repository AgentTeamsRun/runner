import assert from 'node:assert/strict';
import test from 'node:test';
import { toPowerShellEncodedCommand as toAmpCommand } from './amp.js';
import { toPowerShellEncodedCommand as toAntigravityCommand } from './antigravity.js';
import { toPowerShellEncodedCommand as toClaudeCodeCommand } from './claude-code.js';
import { toOpenCodePowerShellEncodedCommand } from './opencode.js';
import { toPowerShellPromptFileRead, toWindowsPromptFilePath } from './windows-prompt-file.js';

const decode = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');
const promptFilePath = "C:/ws/.agentteams/runner/tmp/it's-trigger.prompt.txt";

const builders: Array<[string, (path: string) => string]> = [
  ['opencode', (path) => toOpenCodePowerShellEncodedCommand('C:/bin/opencode.exe', path, 'provider/model')],
  ['claude-code', (path) => toClaudeCodeCommand('C:/bin/claude.cmd', path, 'opus', false, null)],
  ['amp', (path) => toAmpCommand('C:/bin/amp.cmd', path, 'smart')],
  ['antigravity', (path) => toAntigravityCommand('C:/bin/agy.exe', path, 'C:/ws/.agentteams', 'C:/ws/agy.log', 20_000)],
];

for (const [name, build] of builders) {
  test(`${name} Windows script reads the prompt from a file instead of embedding it in a here-string`, () => {
    const script = decode(build(promptFilePath));

    assert.doesNotMatch(script, /@'/, 'no here-string may remain');
    assert.ok(script.includes(toPowerShellPromptFileRead(promptFilePath)), 'prompt must be read from the file');
    assert.ok(script.includes("it''s-trigger"), 'the file path must be a quoted PowerShell literal');
  });
}

test('toWindowsPromptFilePath keeps the prompt under the runner tmp directory', () => {
  assert.match(
    toWindowsPromptFilePath('/ws', 'trigger-1'),
    /\.agentteams[\\/]runner[\\/]tmp[\\/]trigger-1\.prompt\.txt$/,
  );
});
