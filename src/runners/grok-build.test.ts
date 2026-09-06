import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGrokBuildArgs,
  extractGrokResultText,
  getGrokExecutablePreference,
  GrokBuildRunner,
  toGrokBuildPowerShellEncodedCommand,
} from './grok-build.js';
import { parseStreamJsonLine } from './stream-json-parser.js';
import type { RunnerOptions } from './types.js';

const PROMPT_FILE = '/repo/.agentteams/runner/tmp/trigger-1.prompt.md';
const CWD = '/repo';

test('buildGrokBuildArgs passes the prompt by file and pins the structured output contract', () => {
  assert.deepEqual(buildGrokBuildArgs(PROMPT_FILE, CWD), [
    '--prompt-file',
    PROMPT_FILE,
    '--cwd',
    CWD,
    '--output-format',
    'streaming-messages-json',
    '--permission-mode',
    'bypassPermissions',
  ]);
});

// 프롬프트를 `-p`로 넘기면 `-`로 시작하는 마크다운 프롬프트에서 clap이 플래그로 오인해
// exit 2로 죽는다(실측). 인자 배열에 `-p`/`--single`이 절대 들어가면 안 된다.
test('buildGrokBuildArgs never uses the single-prompt flag', () => {
  const args = buildGrokBuildArgs(PROMPT_FILE, CWD, 'grok-4.6');
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--single'), false);
});

test('buildGrokBuildArgs appends the requested model', () => {
  const args = buildGrokBuildArgs(PROMPT_FILE, CWD, 'grok-4.6');
  assert.deepEqual(args.slice(-2), ['-m', 'grok-4.6']);
});

// `default`는 "모델 미지정"을 뜻하는 플랫폼 내부 sentinel이라 그대로 넘기면
// Grok이 unknown model id로 exit 1을 낸다.
test('buildGrokBuildArgs drops the default sentinel and blank models', () => {
  for (const model of ['default', '', '   ', null, undefined]) {
    const args = buildGrokBuildArgs(PROMPT_FILE, CWD, model);
    assert.equal(args.includes('-m'), false, `model ${JSON.stringify(model)} should not be forwarded`);
  }
});

test('getGrokExecutablePreference adds the .exe candidate only on Windows', () => {
  assert.deepEqual(getGrokExecutablePreference(true), ['grok.exe', 'grok']);
  assert.deepEqual(getGrokExecutablePreference(false), ['grok']);
});

test('GrokBuildRunner refuses a conflicting grok before spawning it', async () => {
  let spawnCalled = false;
  const runner = new GrokBuildRunner({
    platform: () => 'linux',
    resolveExecutablePathsWithPreferenceAsync: (async () => ['/usr/local/bin/grok']) as never,
    runProbeCommand: (async () => 'Grok CLI - AI assistant in your terminal') as never,
    mkdir: (async () => undefined) as never,
    spawn: (() => {
      spawnCalled = true;
      throw new Error('must not spawn');
    }) as never,
  });
  const options: RunnerOptions = {
    triggerId: 'trigger-grok-identity',
    prompt: 'private runner prompt',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'GROK_BUILD',
  };

  const result = await runner.run(options);

  assert.equal(spawnCalled, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? '', /official Grok Build executable/);
});

test('GrokBuildRunner re-checks the resolved path immediately before spawn', async () => {
  let probeCount = 0;
  let spawnCalled = false;
  let promptRemoved = false;
  const runner = new GrokBuildRunner({
    platform: () => 'linux',
    resolveExecutablePathsWithPreferenceAsync: (async () => ['/usr/local/bin/grok']) as never,
    runProbeCommand: (async () => {
      probeCount += 1;
      return probeCount === 1 ? 'Grok Build TUI' : 'Grok CLI - AI assistant in your terminal';
    }) as never,
    mkdir: (async () => undefined) as never,
    writeFile: (async () => undefined) as never,
    rm: (async () => {
      promptRemoved = true;
    }) as never,
    spawn: (() => {
      spawnCalled = true;
      throw new Error('must not spawn');
    }) as never,
  });

  const result = await runner.run({
    triggerId: 'trigger-grok-replaced',
    prompt: 'private runner prompt',
    authPath: '/repo',
    apiKey: 'key',
    apiUrl: 'https://api.example.com',
    teamId: 'team',
    projectId: 'project',
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    agentConfigId: 'agent',
    runnerType: 'GROK_BUILD',
  });

  assert.equal(probeCount, 2);
  assert.equal(spawnCalled, false);
  assert.equal(promptRemoved, true);
  assert.match(result.errorMessage ?? '', /changed identity before launch/);
});

// 구조화 출력 플래그가 POSIX 인자와 Windows 커맨드 중 한쪽에만 있으면 그 플랫폼의
// 로그가 통째로 정제되지 않는다. 두 경로가 같은 인자를 싣는지 고정한다.
test('the Windows command carries exactly the POSIX argument vector', () => {
  const encoded = toGrokBuildPowerShellEncodedCommand('C:\\bin\\grok.exe', PROMPT_FILE, CWD, 'grok-4.6');
  const script = Buffer.from(encoded, 'base64').toString('utf16le');

  for (const arg of buildGrokBuildArgs(PROMPT_FILE, CWD, 'grok-4.6')) {
    assert.equal(script.includes(`'${arg}'`), true, `Windows command is missing '${arg}'`);
  }
  assert.equal(script.includes("& 'C:\\bin\\grok.exe'"), true);
});

test('the Windows command escapes single quotes in the resolved path', () => {
  const encoded = toGrokBuildPowerShellEncodedCommand("C:\\o'brien\\grok.exe", PROMPT_FILE, CWD);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(script.includes("& 'C:\\o''brien\\grok.exe'"), true);
});

// 아래 라인은 grok 1.0.3의 실제 실행 캡처다(2026-08-14, `--output-format streaming-messages-json`).
const CAPTURED_SYSTEM_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: '019fff55-0c6a-7e43-a2d8-2ffda29b5b1e',
  apiKeySource: 'oauth',
  model: 'unknown',
  cwd: '/repo',
  permissionMode: 'bypassPermissions',
  tools: ['run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep'],
});

const CAPTURED_TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_0',
    type: 'message',
    role: 'assistant',
    model: 'unknown',
    content: [
      { type: 'thinking', thinking: 'The user wants me to read a.txt in the current directory.' },
      {
        type: 'tool_use',
        id: 'call-347678cc-3274-4fd4-af7d-632ce741b2ae-0',
        name: 'read_file',
        input: { target_file: 'a.txt' },
      },
    ],
    stop_reason: 'tool_use',
  },
  session_id: '019fff55-0c6a-7e43-a2d8-2ffda29b5b1e',
});

const CAPTURED_TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello from probe' }],
    stop_reason: 'end_turn',
  },
});

const CAPTURED_RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4715,
  num_turns: 2,
  result: 'hello from probe',
  stop_reason: 'end_turn',
});

test('the shared stream-json parser refines the captured Grok Build session', () => {
  assert.deepEqual(parseStreamJsonLine(CAPTURED_SYSTEM_LINE), [
    { level: 'INFO', category: 'SYSTEM', message: 'Session initialized (model=unknown, tools=5)' },
  ]);

  assert.deepEqual(parseStreamJsonLine(CAPTURED_TOOL_USE_LINE, { cwd: '/repo' }), [
    { level: 'INFO', category: 'TOOL', toolName: 'read_file', message: '[Tool] read_file: a.txt' },
  ]);

  assert.deepEqual(parseStreamJsonLine(CAPTURED_TEXT_LINE), [
    { level: 'INFO', category: 'TEXT', message: 'hello from probe' },
  ]);

  assert.deepEqual(parseStreamJsonLine(CAPTURED_RESULT_LINE), [
    { level: 'INFO', category: 'RESULT', message: '[Result] Completed in 5s (2 turns)' },
  ]);
});

// Grok의 내장 도구 이름은 Claude Code와 달라서, 매핑이 없으면 `read_file(target_file)`
// 같은 default 요약만 남는다.
test('Grok Build tool names are summarised with their own input keys', () => {
  const summarize = (name: string, input: Record<string, unknown>): string => {
    const [entry] = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }),
      { cwd: '/repo' },
    );
    return entry.message;
  };

  assert.equal(summarize('read_file', { target_file: '/repo/src/a.ts' }), '[Tool] read_file: src/a.ts');
  assert.equal(summarize('write', { file_path: '/repo/b.txt', content: 'second\n' }), '[Tool] write: b.txt');
  assert.equal(
    summarize('search_replace', { file_path: '/repo/a.txt', old_string: 'hello', new_string: 'HELLO' }),
    '[Tool] search_replace: a.txt',
  );
  assert.equal(summarize('list_dir', { target_directory: '/repo/src' }), '[Tool] list_dir: src');
  assert.equal(summarize('grep', { pattern: 'hello' }), '[Tool] grep: "hello"');
  assert.equal(
    summarize('run_terminal_command', { command: 'wc -l a.txt', description: 'Count lines' }),
    '[Tool] run_terminal_command: wc -l a.txt',
  );
  assert.equal(
    summarize('spawn_subagent', { description: 'Read a.txt contents' }),
    '[Tool] spawn_subagent: Read a.txt contents',
  );
  assert.equal(
    summarize('get_command_or_subagent_output', {
      task_ids: ['019fff56-d13f-7131-a267-874b0b7b728a'],
      timeout_ms: 60_000,
    }),
    '[Tool] get_command_or_subagent_output: 1 task(s)',
  );
  assert.equal(summarize('todo_write', { todos: [{}, {}] }), '[Tool] todo_write: 2 item(s)');
});

test('a failing run is reported as an error result', () => {
  // 인증이 없을 때 실측한 종료 이벤트(exit code 1과 함께 나온다).
  const line = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 0,
    num_turns: 0,
    result: 'Not signed in.',
  });

  // 인증 실패는 duration_ms=0으로 오고, 파서는 falsy duration을 'unknown'으로 표기한다.
  assert.deepEqual(parseStreamJsonLine(line), [
    { level: 'WARN', category: 'RESULT', message: '[Result] Error after unknown (0 turns): Not signed in.' },
  ]);
});

test('extractGrokResultText pulls the final answer out of the captured NDJSON', () => {
  const captured = [CAPTURED_SYSTEM_LINE, CAPTURED_TOOL_USE_LINE, CAPTURED_TEXT_LINE, CAPTURED_RESULT_LINE].join('\n');
  assert.equal(extractGrokResultText(captured), 'hello from probe');
});

test('extractGrokResultText keeps the raw output when no result line survived', () => {
  const captured = [CAPTURED_SYSTEM_LINE, CAPTURED_TOOL_USE_LINE].join('\n');
  assert.equal(extractGrokResultText(captured), captured);
});

test('Grok effort는 재실행마다 정확히 한 번 전달하고 기본값은 생략한다', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const args = buildGrokBuildArgs(PROMPT_FILE, CWD, 'grok-4.6', effort);
    assert.equal(args.filter((arg) => arg === '--reasoning-effort').length, 1);
    assert.equal(args[args.indexOf('--reasoning-effort') + 1], effort);
    const script = Buffer.from(
      toGrokBuildPowerShellEncodedCommand('C:/grok.exe', PROMPT_FILE, CWD, 'grok-4.6', effort),
      'base64',
    ).toString('utf16le');
    assert.ok(script.includes(`'--reasoning-effort' '${effort}'`));
  }
  for (const effort of [undefined, null, '', '   ']) {
    assert.equal(buildGrokBuildArgs(PROMPT_FILE, CWD, 'grok-4.6', effort).includes('--reasoning-effort'), false);
  }
});
