import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  buildPlistContent,
  buildSystemdContent,
  buildWindowsVbsContent,
  launchWindowsHiddenDaemon,
} from './autostart.js';

const originalPath = process.env.PATH;

test.afterEach(() => {
  mock.restoreAll();
  process.env.PATH = originalPath;
});

test('buildWindowsVbsContent launches agentrunner hidden with inherited env', () => {
  process.env.PATH = 'C:\\Windows\\System32;C:\\Users\\rlaru\\AppData\\Roaming\\npm';

  const content = buildWindowsVbsContent(
    {
      token: 'daemon-token',
      apiUrl: 'https://api.agentteams.run',
    },
    'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\agentrunner.cmd',
  );

  assert.match(content, /Set shell = CreateObject\("WScript\.Shell"\)/u);
  assert.match(content, /env\("AGENTTEAMS_DAEMON_TOKEN"\) = "daemon-token"/u);
  assert.match(content, /env\("AGENTTEAMS_API_URL"\) = "https:\/\/api\.agentteams\.run"/u);
  assert.match(content, /shell\.Run """.*agentrunner\.cmd"" start", 0, False/u);
});

test('buildWindowsVbsContent injects CODEX_SANDBOX_LEVEL=off', () => {
  const content = buildWindowsVbsContent(
    {
      token: 't',
      apiUrl: 'http://localhost:3001',
    },
    'agentrunner.cmd',
  );

  assert.match(content, /env\("CODEX_SANDBOX_LEVEL"\) = "off"/u);
});

test('buildPlistContent injects CODEX_SANDBOX_LEVEL=off', () => {
  const content = buildPlistContent({
    token: 't',
    apiUrl: 'http://localhost:3001',
  });

  assert.match(content, /CODEX_SANDBOX_LEVEL/u);
  assert.match(content, /<key>CODEX_SANDBOX_LEVEL<\/key>\s*\n\s*<string>off<\/string>/u);
});

test('buildSystemdContent injects CODEX_SANDBOX_LEVEL=off', () => {
  const content = buildSystemdContent({
    token: 't',
    apiUrl: 'http://localhost:3001',
  });

  assert.match(content, /Environment="CODEX_SANDBOX_LEVEL=off"/u);
});

test('buildWindowsVbsContent always launches with shell.Run style=0 (hidden)', () => {
  const content = buildWindowsVbsContent(
    {
      token: 't',
      apiUrl: 'http://localhost:3001',
    },
    'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\agentrunner.cmd',
  );

  // Style 0 = hidden window; False = don't wait. Both are required for hidden launch.
  assert.match(content, /, 0, False$/mu);
});

test('launchWindowsHiddenDaemon reuses the registered startup VBS when present', () => {
  const execCalls: string[] = [];

  launchWindowsHiddenDaemon({
    existsSync: () => true,
    writeFileSync: () => {
      throw new Error('should not write a new VBS when startup VBS exists');
    },
    mkdirSync: () => undefined,
    execSync: ((command: string, options: { windowsHide: boolean }) => {
      execCalls.push(command);
      assert.equal(options.windowsHide, true, 'wscript spawn must be hidden');
      return Buffer.from('');
    }) as unknown as (command: string, options: { windowsHide: boolean }) => unknown,
    getAutostartConfig: () => null,
  });

  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0]!, /^wscript\.exe ".*agentrunner-start\.vbs"$/u);
  assert.doesNotMatch(execCalls[0]!, /powershell/iu, 'must not fall through to PowerShell');
});

test('launchWindowsHiddenDaemon writes a fresh VBS and runs wscript when no startup VBS exists', () => {
  const writes: Array<{ path: string; content: string }> = [];
  const execCalls: string[] = [];

  launchWindowsHiddenDaemon({
    existsSync: () => false,
    writeFileSync: (path, content) => {
      writes.push({ path, content });
    },
    mkdirSync: () => undefined,
    execSync: ((command: string, options: { windowsHide: boolean }) => {
      execCalls.push(command);
      assert.equal(options.windowsHide, true);
      return Buffer.from('');
    }) as unknown as (command: string, options: { windowsHide: boolean }) => unknown,
    getAutostartConfig: () => ({ token: 'tok', apiUrl: 'https://api.example' }),
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0]!.path, /agentrunner-restart\.vbs$/u);
  assert.match(writes[0]!.content, /env\("AGENTTEAMS_DAEMON_TOKEN"\) = "tok"/u);
  assert.match(writes[0]!.content, /, 0, False$/mu);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0]!, /^wscript\.exe ".*agentrunner-restart\.vbs"$/u);
});

test('launchWindowsHiddenDaemon throws when no startup VBS and no config is available', () => {
  assert.throws(
    () =>
      launchWindowsHiddenDaemon({
        existsSync: () => false,
        writeFileSync: () => {
          throw new Error('should not write');
        },
        mkdirSync: () => undefined,
        execSync: (() => {
          throw new Error('should not exec');
        }) as unknown as (command: string, options: { windowsHide: boolean }) => unknown,
        getAutostartConfig: () => null,
      }),
    /AGENTTEAMS_DAEMON_TOKEN/u,
  );
});
