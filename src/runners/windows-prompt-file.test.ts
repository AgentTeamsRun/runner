import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPowerShellEncodedCommand as toAmpCommand } from './amp.js';
import { toPowerShellEncodedCommand as toAntigravityCommand } from './antigravity.js';
import { toPowerShellEncodedCommand as toClaudeCodeCommand } from './claude-code.js';
import { toOpenCodePowerShellEncodedCommand } from './opencode.js';
import {
  toPowerShellNativeInvocation,
  toPowerShellPromptFileRead,
  toWindowsPromptFilePath,
} from './windows-prompt-file.js';

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

test('toPowerShellNativeInvocation quotes native arguments itself instead of relying on PowerShell 5.1', () => {
  const line = toPowerShellNativeInvocation("C:/bin/O'Brien/amp.exe", " '--execute' $promptText");

  assert.ok(line.includes('function ConvertTo-NativeArgument'), line);
  assert.ok(line.endsWith("Invoke-NativeCommand 'C:/bin/O''Brien/amp.exe' '--execute' $promptText"), line);
});

test('toPowerShellNativeInvocation keeps the call operator for .cmd and .bat shims', () => {
  assert.equal(
    toPowerShellNativeInvocation('C:/bin/copilot.CMD', " '-p' $promptText"),
    "& 'C:/bin/copilot.CMD' '-p' $promptText",
  );
  assert.equal(toPowerShellNativeInvocation('C:/bin/kimi.bat', ' $promptText'), "& 'C:/bin/kimi.bat' $promptText");
});

for (const extension of ['ps1', 'PS1']) {
  test(`toPowerShellNativeInvocation keeps the call operator for .${extension} scripts`, () => {
    const executablePath = `C:/bin/claude.${extension}`;
    const line = toPowerShellNativeInvocation(executablePath, " '-p' $promptText");

    assert.ok(line.startsWith(`& '${executablePath}' '-p' $promptText`), line);
    assert.doesNotMatch(line, /Invoke-NativeCommand/);
  });
}

test(
  'toPowerShellNativeInvocation passes quotes, backslashes and Korean to a native executable verbatim',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentteams-native-args-'));
    try {
      // Windows PowerShell 5.1 split `"hello world"` and `a "b" c` into several arguments with the `&` operator.
      const values = ['"hello world"', 'a "b" & c', 'trailing\\', 'a\\"b', '한글 인자', "'@\nWrite-Output 'INJECTED'"];
      const lines = values.map((value, index) => {
        const valuePath = join(dir, `value-${index}.txt`);
        writeFileSync(valuePath, value, 'utf8');
        return `$value${index} = [System.IO.File]::ReadAllText('${valuePath}', $utf8NoBom)`;
      });
      const script = [
        '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
        '[Console]::OutputEncoding = $utf8NoBom',
        ...lines,
        toPowerShellNativeInvocation(
          process.execPath,
          ` '-e' 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'${values.map((_, index) => ` $value${index}`).join('')}`,
        ),
      ].join('\r\n');
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );

      assert.deepEqual(JSON.parse(output), values);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
