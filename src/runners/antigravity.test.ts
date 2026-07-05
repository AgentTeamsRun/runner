import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildAntigravityExecArgs,
  createAntigravityInternalLogForwarder,
  extractAntigravityReadableEvent,
  sanitizeAntigravityInternalLogLine,
  toPowerShellEncodedCommand,
} from './antigravity.js';

test('buildAntigravityExecArgs uses verified print-mode contract', () => {
  const cwd = '/tmp/agentteams-project';
  const agentteamsDir = join(cwd, '.agentteams');
  const internalLogPath = join(agentteamsDir, 'runner', 'log', 'trigger.antigravity.log');

  assert.equal(isAbsolute(agentteamsDir), true);
  assert.deepEqual(buildAntigravityExecArgs('hello', agentteamsDir, internalLogPath, 20_000, 'gemini-3'), [
    '--dangerously-skip-permissions',
    '--add-dir',
    agentteamsDir,
    '--log-file',
    internalLogPath,
    '--print-timeout',
    '20s',
    '--model',
    'gemini-3',
    '--print',
    'hello',
  ]);
});

test('buildAntigravityExecArgs defaults print timeout to runner fail-safe window', () => {
  const cwd = '/tmp/agentteams-project';
  const agentteamsDir = join(cwd, '.agentteams');
  const internalLogPath = join(agentteamsDir, 'runner', 'log', 'trigger.antigravity.log');

  assert.deepEqual(buildAntigravityExecArgs('hello', agentteamsDir, internalLogPath), [
    '--dangerously-skip-permissions',
    '--add-dir',
    agentteamsDir,
    '--log-file',
    internalLogPath,
    '--print-timeout',
    '86400s',
    '--print',
    'hello',
  ]);
});

test('toPowerShellEncodedCommand forwards absolute add-dir and log-file', () => {
  const cwd = 'C:\\Users\\agent\\project';
  const agentteamsDir = `${cwd}\\.agentteams`;
  const internalLogPath = `${agentteamsDir}\\runner\\log\\trigger.antigravity.log`;
  const encoded = toPowerShellEncodedCommand(
    'C:\\Tools\\agy.cmd',
    'hello',
    agentteamsDir,
    internalLogPath,
    20_000,
    'gemini-3',
  );
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');

  assert.match(decoded, /'--add-dir' 'C:\\Users\\agent\\project\\.agentteams'/);
  assert.match(
    decoded,
    /'--log-file' 'C:\\Users\\agent\\project\\.agentteams\\runner\\log\\trigger\.antigravity\.log'/,
  );
  assert.match(decoded, /'--model' 'gemini-3'/);
  assert.doesNotMatch(decoded, /'--add-dir' '\.agentteams'/);
});

test('createAntigravityInternalLogForwarder polls appended lines without duplicates', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agentteams-antigravity-'));
  const logPath = join(tempDir, 'internal.log');
  const forwarded: string[] = [];
  let activityCount = 0;
  const forwarder = createAntigravityInternalLogForwarder({
    logPath,
    triggerId: 'trigger-id',
    pollMs: 20,
    onLine: (line) => forwarded.push(line),
    onActivity: () => {
      activityCount += 1;
    },
  });

  try {
    await writeFile(
      logPath,
      'I0524 00:18:12.649978 87309 server_oauth.go:217] OAuth: authenticated successfully as user@example.com\n',
    );
    forwarder.start();
    await sleep(60);
    await appendFile(
      logPath,
      [
        'I0524 00:18:16.261389 87309 server.go:747] Created conversation 1e5397df-a0b6-4194-92e3-3de0084e8945',
        'I0524 00:18:56.816107 87309 tool_confirmation_manager.go:72] Auto-approving tool confirmation: "Edit" at step 24',
        'I0524 00:19:08.977946 87309 server.go:2160] Language server shutting down',
      ].join('\n'),
    );
    await sleep(60);
    forwarder.stop();
    await forwarder.flush();

    assert.deepEqual(forwarded, [
      '[Session] Authenticated as user@example.com',
      '[Session] Conversation: 1e5397df',
      '[Tool] Edit (step 24)',
      '[Result] Session ended',
    ]);
    assert.equal(activityCount, 4);
  } finally {
    forwarder.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('createAntigravityInternalLogForwarder masks secrets and limits emitted lines each tick', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agentteams-antigravity-'));
  const logPath = join(tempDir, 'internal.log');
  const forwarded: string[] = [];
  const lines = [
    'E0524 00:18:12.410878 87309 server.go:604] Failed to call backend with Authorization: Bearer super-secret-token',
    'E0524 00:18:12.410879 87309 server.go:604] Failed to call backend with api_key=abc123',
    ...Array.from(
      { length: 25 },
      (_, index) =>
        `I0524 00:18:${String(index).padStart(2, '0')}.816107 87309 tool_confirmation_manager.go:72] Auto-approving tool confirmation: "Edit" at step ${index}`,
    ),
  ];
  const forwarder = createAntigravityInternalLogForwarder({
    logPath,
    triggerId: 'trigger-id',
    onLine: (line) => forwarded.push(line),
  });

  try {
    await writeFile(logPath, `${lines.join('\n')}\n`);
    await forwarder.flush();

    assert.equal(forwarded.length, 20);
    assert.equal(forwarded[0], 'Failed to call backend with Authorization: Bearer [REDACTED]');
    assert.equal(forwarded[1], 'Failed to call backend with api_key=[REDACTED]');
    assert.equal(
      forwarded.some((line) => line.includes('super-secret-token') || line.includes('abc123')),
      false,
    );
  } finally {
    forwarder.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sanitizeAntigravityInternalLogLine redacts token-like values', () => {
  const sanitized = sanitizeAntigravityInternalLogLine(
    'access_token: abc refresh_token=def cookie=sessionid token eyJabc.def.ghi',
  );

  assert.equal(sanitized.includes('abc'), false);
  assert.equal(sanitized.includes('def'), false);
  assert.equal(sanitized.includes('eyJabc.def.ghi'), false);
  assert.match(sanitized, /\[REDACTED\]/);
});

test('extractAntigravityReadableEvent returns readable events for whitelisted categories', () => {
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:18:12.649978 87309 server_oauth.go:217] OAuth: authenticated successfully as user@example.com',
    ),
    { message: '[Session] Authenticated as user@example.com', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:18:12.413146 87309 common.go:156] project: using project "/Users/justin/Project/Me/AgentTeams" (id=341f61de-cb14-4ef7-a6a6-14dc43eb3e10) at /Users/justin/.gemini/config/projects/341f61de-cb14-4ef7-a6a6-14dc43eb3e10.json',
    ),
    { message: '[Session] Project: AgentTeams (#341f61de)', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:18:12.413325 87309 printmode.go:71] Print mode: starting (promptLength=2066, model="", conversationID="")',
    ),
    { message: '[Session] Session started (prompt=2066 chars)', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:18:15.228104 87309 model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
    ),
    { message: '[Session] Model: Gemini 3.5 Flash (Medium)', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:18:16.261389 87309 server.go:747] Created conversation 1e5397df-a0b6-4194-92e3-3de0084e8945',
    ),
    { message: '[Session] Conversation: 1e5397df', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:18:56.816107 87309 tool_confirmation_manager.go:72] Auto-approving tool confirmation: "Edit" at step 24',
    ),
    { message: '[Tool] Edit (step 24)', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'I0524 00:19:08.955392 87309 text_drip.go:173] Drip stopped: lastStepIdx=29, charIdx=1037, length=1037',
    ),
    { message: '[Result] Streamed 1037 chars', level: 'INFO' },
  );
  assert.deepEqual(
    extractAntigravityReadableEvent('I0524 00:19:08.977946 87309 server.go:2160] Language server shutting down'),
    { message: '[Result] Session ended', level: 'INFO' },
  );
});

test('extractAntigravityReadableEvent drops Antigravity infrastructure noise', () => {
  const noiseLines = [
    'I0524 00:18:14.247754 87309 http_helpers.go:182] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist Trace: 0xe2ae4ed23f845f29',
    'I0524 00:18:18.284057 87309 printmode_manager.go:90] PlannerResponse without ModifiedResponse encountered',
    'W0524 00:18:12.402695 87309 log_context.go:117] Cache(loadCodeAssistResponse): Singleflight refresh failed: error getting token source: You are not logged into Antigravity.',
    'I0524 00:18:19.937499 87309 manager.go:932] Reloading system slash commands',
    'I0524 00:18:20.020009 87309 experiment_manager.go:39] Experiments refreshed after login',
    'I0524 00:18:12.412605 87309 auto_updater.go:253] Spawned background update process with PID 87320',
    'E0524 00:18:12.402172 87309 log.go:398] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.',
  ];

  for (const line of noiseLines) {
    assert.equal(extractAntigravityReadableEvent(line), null, line);
  }
});

test('extractAntigravityReadableEvent forwards non-login errors as warnings', () => {
  assert.deepEqual(
    extractAntigravityReadableEvent(
      'E0524 00:18:12.413185 87309 common.go:188] Failed to resolve GeminiDir ".gemini": .gemini must be an absolute path: path is not absolute, falling back to default',
    ),
    {
      message:
        'Failed to resolve GeminiDir ".gemini": .gemini must be an absolute path: path is not absolute, falling back to default',
      level: 'WARN',
    },
  );
});

test('createAntigravityInternalLogForwarder emits model only once and routes warnings', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agentteams-antigravity-'));
  const logPath = join(tempDir, 'internal.log');
  const forwarded: string[] = [];
  const warnings: string[] = [];
  const forwarder = createAntigravityInternalLogForwarder({
    logPath,
    triggerId: 'trigger-id',
    onLine: (line) => forwarded.push(line),
    onWarnLine: (line) => warnings.push(line),
  });

  try {
    await writeFile(
      logPath,
      [
        'I0524 00:18:15.228104 87309 model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
        'I0524 00:18:19.079321 87309 model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
        'E0524 00:18:12.413185 87309 common.go:188] Failed to resolve GeminiDir ".gemini": .gemini must be an absolute path: path is not absolute, falling back to default',
      ].join('\n'),
    );
    await forwarder.flush();

    assert.deepEqual(forwarded, ['[Session] Model: Gemini 3.5 Flash (Medium)']);
    assert.deepEqual(warnings, [
      'Failed to resolve GeminiDir ".gemini": .gemini must be an absolute path: path is not absolute, falling back to default',
    ]);
  } finally {
    forwarder.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
