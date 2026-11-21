import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POWERSHELL_RUNNER_PREAMBLE, toPowerShellNativeInvocation } from './runners/windows-prompt-file.js';
import { toPowerShellEncodedCommand as toClaudeCodeCommand } from './runners/claude-code.js';
import { resolveWindowsCmdShimTarget } from './windows-cmd-shim.js';

// npm(cmd-shim)이 실제로 만드는 두 형태. 2026-11-21 windows-verify의 전역 설치본에서 그대로 옮겼다.
const nodeScriptShim = (scriptRelativePath: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRelativePath}" %*`,
    '',
  ].join('\r\n');

const nativeBinaryShim = (binaryRelativePath: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    `"%dp0%\\${binaryRelativePath}"   %*`,
    '',
  ].join('\r\n');

test('resolveWindowsCmdShimTarget unwraps an npm node-script shim to node plus the script', () => {
  const target = resolveWindowsCmdShimTarget('C:\\npm\\amp.cmd', {
    readFile: () => nodeScriptShim('node_modules\\@sourcegraph\\amp\\dist\\main.js'),
    isFile: (path) => path === 'C:\\npm\\node_modules\\@sourcegraph\\amp\\dist\\main.js',
    nodeExecutablePath: 'C:\\nodejs\\node.exe',
  });

  assert.deepEqual(target, {
    executablePath: 'C:\\nodejs\\node.exe',
    leadingArgs: ['C:\\npm\\node_modules\\@sourcegraph\\amp\\dist\\main.js'],
  });
});

test('resolveWindowsCmdShimTarget prefers the node.exe that sits next to the shim, as the shim does', () => {
  const target = resolveWindowsCmdShimTarget('C:\\npm\\amp.cmd', {
    readFile: () => nodeScriptShim('node_modules\\amp\\main.js'),
    isFile: () => true,
    nodeExecutablePath: 'C:\\nodejs\\node.exe',
  });

  assert.equal(target?.executablePath, 'C:\\npm\\node.exe');
});

test('resolveWindowsCmdShimTarget unwraps an npm native-binary shim to the binary', () => {
  const target = resolveWindowsCmdShimTarget('C:\\npm\\pnpm.CMD', {
    readFile: () => nativeBinaryShim('node_modules\\pnpm\\pnpm.exe'),
    isFile: (path) => path === 'C:\\npm\\node_modules\\pnpm\\pnpm.exe',
  });

  assert.deepEqual(target, { executablePath: 'C:\\npm\\node_modules\\pnpm\\pnpm.exe', leadingArgs: [] });
});

test('resolveWindowsCmdShimTarget refuses to guess for anything that is not a known npm shim', () => {
  const isFile = (): boolean => true;
  // 직접 쓴 배치 파일: 마지막 줄이 shim 형태가 아니다.
  assert.equal(
    resolveWindowsCmdShimTarget('C:\\tools\\wrap.cmd', {
      readFile: () => '@echo off\r\nnode "%~dp0main.js" %*\r\n',
      isFile,
    }),
    null,
  );
  // node가 아닌 인터프리터를 쓰는 shim.
  assert.equal(
    resolveWindowsCmdShimTarget('C:\\npm\\tool.cmd', {
      readFile: () => nodeScriptShim('node_modules\\tool\\run.sh').replace('SET "_prog=node"', 'SET "_prog=sh"'),
      isFile,
    }),
    null,
  );
  // 대상 파일이 없다.
  assert.equal(
    resolveWindowsCmdShimTarget('C:\\npm\\amp.cmd', {
      readFile: () => nodeScriptShim('node_modules\\amp\\main.js'),
      isFile: () => false,
    }),
    null,
  );
  // .cmd가 아니거나 읽을 수 없다.
  assert.equal(resolveWindowsCmdShimTarget('C:\\bin\\amp.exe', { readFile: () => '', isFile }), null);
  assert.equal(
    resolveWindowsCmdShimTarget('C:\\npm\\amp.cmd', {
      readFile: () => {
        throw new Error('ENOENT');
      },
      isFile,
    }),
    null,
  );
});

const runEncoded = (script: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// 받은 인자와 stdin을 JSON으로 되돌려 주고 종료 코드 7로 끝나는 가짜 엔진을 npm 전역 설치 모양으로 만든다.
const installFakeEngine = (prefix: string): string => {
  const packageDir = join(prefix, 'node_modules', 'fake-engine');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'main.js'),
    "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:d}));process.exit(7)});",
    'utf8',
  );
  const shimPath = join(prefix, 'fake-engine.cmd');
  writeFileSync(shimPath, nodeScriptShim('node_modules\\fake-engine\\main.js'), 'utf8');
  return shimPath;
};

test(
  'a prompt passed as an argument reaches an engine installed behind an npm .cmd shim verbatim',
  { skip: process.platform !== 'win32' },
  () => {
    const prefix = mkdtempSync(join(tmpdir(), 'agentteams shim '));
    try {
      const shimPath = installFakeEngine(prefix);
      // cmd.exe를 거치면: 첫 줄에서 잘리고 뒤 플래그가 사라지며, `&` 뒤가 명령으로 실행되고, %OS%가 확장된다.
      const prompt = ['line one "quoted"', 'say "hi & echo INJECTED', 'value is %OS% ^ | < >', '한글 prompt'].join(
        '\n',
      );
      const promptPath = join(prefix, 'prompt.txt');
      writeFileSync(promptPath, prompt, 'utf8');

      const script = [
        ...POWERSHELL_RUNNER_PREAMBLE,
        `$promptText = [System.IO.File]::ReadAllText('${promptPath}', $utf8NoBom)`,
        toPowerShellNativeInvocation(shimPath, " '-p' $promptText '--after' 'a b'"),
      ].join('\r\n');
      const result = runEncoded(script);

      assert.deepEqual((JSON.parse(result.stdout) as { argv: string[] }).argv, ['-p', prompt, '--after', 'a b']);
      assert.equal(result.status, 7, 'the engine exit code must survive');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  },
);

test(
  'a long prompt is not capped by the cmd.exe 8191-character limit when the engine sits behind a .cmd shim',
  { skip: process.platform !== 'win32' },
  () => {
    const prefix = mkdtempSync(join(tmpdir(), 'agentteams-shim-long-'));
    try {
      const shimPath = installFakeEngine(prefix);
      const prompt = 'p'.repeat(20_000);
      const promptPath = join(prefix, 'prompt.txt');
      writeFileSync(promptPath, prompt, 'utf8');

      const result = runEncoded(
        [
          ...POWERSHELL_RUNNER_PREAMBLE,
          `$promptText = [System.IO.File]::ReadAllText('${promptPath}', $utf8NoBom)`,
          toPowerShellNativeInvocation(shimPath, " '-p' $promptText"),
        ].join('\r\n'),
      );

      assert.equal((JSON.parse(result.stdout) as { argv: string[] }).argv[1]?.length, 20_000);
      assert.equal(result.status, 7);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  },
);

test(
  'a stdin runner keeps cmd.exe from re-parsing its arguments when the engine sits behind a .cmd shim',
  { skip: process.platform !== 'win32' },
  () => {
    const prefix = mkdtempSync(join(tmpdir(), 'agentteams-shim-stdin-'));
    try {
      const shimPath = installFakeEngine(prefix);
      const promptPath = join(prefix, 'prompt.txt');
      writeFileSync(promptPath, '한글 "prompt"', 'utf8');

      // 모델 이름은 서버가 준 값이다. cmd.exe를 거치면 `&` 뒤가 명령으로 실행되고 %OS%가 확장된다.
      const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NonInteractive', '-EncodedCommand', toClaudeCodeCommand(shimPath, promptPath, 'a&b|%OS%^c')],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(result.stdout) as { argv: string[]; stdin: string };

      assert.equal(parsed.argv[parsed.argv.indexOf('--model') + 1], 'a&b|%OS%^c');
      assert.equal(parsed.stdin.trim(), '한글 "prompt"');
      assert.equal(result.status, 7);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  },
);

test(
  'a PowerShell launch failure reaches stderr as a readable message instead of CLIXML',
  { skip: process.platform !== 'win32' },
  () => {
    const result = runEncoded(
      [...POWERSHELL_RUNNER_PREAMBLE, toPowerShellNativeInvocation('C:/nope/missing-engine.exe', " '-p' 'x'")].join(
        '\r\n',
      ),
    );

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /CLIXML|<Objs/);
    // 메시지 문구는 OS 표시 언어를 따르므로 내용이 아니라 "평문 한 줄"인지만 본다.
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
    assert.ok(result.stderr.trim().length > 0);
  },
);
