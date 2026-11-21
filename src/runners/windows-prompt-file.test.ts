import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPowerShellEncodedCommand as toAmpCommand } from './amp.js';
import { toPowerShellEncodedCommand as toAntigravityCommand } from './antigravity.js';
import { toPowerShellEncodedCommand as toClaudeCodeCommand } from './claude-code.js';
import { toOpenCodePowerShellEncodedCommand } from './opencode.js';
import {
  POWERSHELL_RUNNER_PREAMBLE,
  toPowerShellNativeArgLiteral,
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
  assert.ok(
    line.endsWith("Invoke-NativeCommand 'C:/bin/O''Brien/amp.exe' '--execute' $promptText\r\nexit $LASTEXITCODE"),
    line,
  );
});

test('toPowerShellNativeInvocation keeps the call operator for .cmd and .bat shims', () => {
  assert.equal(
    toPowerShellNativeInvocation('C:/bin/copilot.CMD', " '-p' $promptText"),
    "& 'C:/bin/copilot.CMD' '-p' $promptText\r\nexit $LASTEXITCODE",
  );
  assert.equal(
    toPowerShellNativeInvocation('C:/bin/kimi.bat', ' $promptText'),
    "& 'C:/bin/kimi.bat' $promptText\r\nexit $LASTEXITCODE",
  );
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

test('toPowerShellNativeArgLiteral pre-escapes embedded quotes for the PowerShell 5.1 call operator', () => {
  assert.equal(toPowerShellNativeArgLiteral('--model'), "'--model'");
  assert.equal(toPowerShellNativeArgLiteral('{"fastMode":true}'), String.raw`'{\"fastMode\":true}'`);
  assert.equal(toPowerShellNativeArgLiteral(String.raw`a\"b`), String.raw`'a\\\"b'`);
  // PowerShell 5.1 wraps an argument with whitespace in quotes, so a trailing backslash must not escape the closer.
  assert.equal(toPowerShellNativeArgLiteral('C:\\my repo\\'), "'C:\\my repo\\\\'");
  assert.equal(toPowerShellNativeArgLiteral('C:\\repo\\'), "'C:\\repo\\'");
  assert.equal(toPowerShellNativeArgLiteral("it's"), "'it''s'");
  // The call operator drops an empty argument; a literal pair of quotes arrives as one.
  assert.equal(toPowerShellNativeArgLiteral(''), `'""'`);
});

test('toPowerShellNativeArgLiteral refuses an argument PowerShell 5.1 would split instead of passing it wrong', () => {
  // All whitespace sits inside a quote pair, so 5.1 does not wrap the argument and it splits at the space.
  assert.throws(() => toPowerShellNativeArgLiteral('a="b c"'), /Cannot pass argument/);
  assert.throws(() => toPowerShellNativeArgLiteral('"hello world"'), /Cannot pass argument/);
});

const runEncoded = (encoded: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// 받은 인자와 stdin을 JSON으로 되돌려 주고 종료 코드 7로 끝나는 가짜 엔진.
const writeFakeEngine = (dir: string): { cmdPath: string; scriptPath: string } => {
  const scriptPath = join(dir, 'engine.js');
  const cmdPath = join(dir, 'engine.cmd');
  writeFileSync(
    scriptPath,
    "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:d}));process.exit(7)});",
    'utf8',
  );
  writeFileSync(cmdPath, `@ECHO off\r\n"${process.execPath}" "%~dp0engine.js" %*\r\n`, 'utf8');
  return { cmdPath, scriptPath };
};

test(
  'claude-code Windows script delivers the fast-mode settings JSON, the prompt and the exit code through a .cmd shim',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentteams-claude-win-'));
    try {
      const { cmdPath } = writeFakeEngine(dir);
      const promptPath = join(dir, 'prompt.txt');
      writeFileSync(promptPath, '한글 "prompt"', 'utf8');

      const result = runEncoded(toClaudeCodeCommand(cmdPath, promptPath, 'opus', true, 'high'));
      const parsed = JSON.parse(result.stdout) as { argv: string[]; stdin: string };

      // Windows PowerShell 5.1 used to deliver the settings argument as {fastMode:true}, which is not JSON.
      assert.deepEqual(JSON.parse(parsed.argv[parsed.argv.indexOf('--settings') + 1] ?? ''), { fastMode: true });
      assert.equal(parsed.stdin.trim(), '한글 "prompt"');
      assert.equal(result.status, 7, 'the engine exit code must not collapse to 1');
      assert.equal(result.stderr, '', 'no CLIXML progress record may reach stderr');

      // prompt를 인자로 넘기는 러너: .cmd(`&`)와 .exe(Invoke-NativeCommand) 두 분기 모두 종료 코드를 보존한다.
      for (const [executablePath, leadingArgs] of [
        [cmdPath, ''],
        [process.execPath, ` '${join(dir, 'engine.js')}'`],
      ] as const) {
        const script = [
          ...POWERSHELL_RUNNER_PREAMBLE,
          toPowerShellNativeInvocation(executablePath, `${leadingArgs} '--flag'`),
        ].join('\r\n');
        const invoked = runEncoded(Buffer.from(script, 'utf16le').toString('base64'));

        assert.deepEqual((JSON.parse(invoked.stdout) as { argv: string[] }).argv, ['--flag'], executablePath);
        assert.equal(invoked.status, 7, executablePath);
        assert.equal(invoked.stderr, '', executablePath);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'the PowerShell 5.1 call operator delivers pre-escaped arguments verbatim to .cmd shims and executables',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentteams-native-literal-'));
    try {
      const { cmdPath, scriptPath } = writeFakeEngine(dir);
      const values = [
        '{"fastMode":true}',
        'model_reasoning_effort="high"',
        'C:\\my repo\\',
        'C:\\repo\\',
        '{"a": "b c"}',
        "it's",
        'tail\\"',
        '',
        // U+0085는 .NET에서만 공백이다: 5.1이 감싸므로 끝의 `\`를 두 배로 늘려야 한다.
        `a${String.fromCharCode(0x85)}b\\`,
        // U+FEFF는 JS에서만 공백이다: 5.1이 감싸지 않으므로 `\`를 건드리면 안 된다.
        `a${String.fromCharCode(0xfeff)}b\\`,
        'last',
      ];
      const argSegment = values.map((value) => ` ${toPowerShellNativeArgLiteral(value)}`).join('');
      const targets = [
        toPowerShellNativeArgLiteral(cmdPath),
        `${toPowerShellNativeArgLiteral(process.execPath)} ${toPowerShellNativeArgLiteral(scriptPath)}`,
      ];

      for (const target of targets) {
        const script = [...POWERSHELL_RUNNER_PREAMBLE, `'' | & ${target}${argSegment}`, 'exit $LASTEXITCODE'].join(
          '\r\n',
        );
        const result = runEncoded(Buffer.from(script, 'utf16le').toString('base64'));

        assert.deepEqual((JSON.parse(result.stdout) as { argv: string[] }).argv, values, target);
        assert.equal(result.status, 7);
        assert.equal(result.stderr, '');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
