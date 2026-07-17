import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  buildPlistContent,
  buildSystemdContent,
  buildWindowsPowerShellWrapper,
  buildWindowsTaskXmlContent,
  getAutostartStatus,
  launchWindowsHiddenDaemon,
  registerWindowsTask,
  restartWindowsTask,
  scheduleWindowsTaskRestart,
  unregisterWindowsTask,
} from './autostart.js';

const originalPath = process.env.PATH;

test.afterEach(() => {
  mock.restoreAll();
  process.env.PATH = originalPath;
});

test('buildWindowsTaskXmlContent configures supervised hidden logon startup', () => {
  const content = buildWindowsTaskXmlContent('DOMAIN\\runner', 'C:\\Users\\runner\\.agentteams\\agentrunner-start.ps1');

  assert.match(content, /<LogonTrigger>/u);
  assert.match(content, /<UserId>DOMAIN\\runner<\/UserId>/u);
  assert.match(content, /<Hidden>true<\/Hidden>/u);
  assert.match(content, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(content, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/u);
  assert.match(content, /<Command>powershell\.exe<\/Command>/u);
  assert.match(content, /-WindowStyle Hidden/u);
});

test('buildWindowsPowerShellWrapper passes environment and rotates the bounded daemon log', () => {
  const content = buildWindowsPowerShellWrapper(
    { token: "tok'en", apiUrl: 'https://api.example' },
    'C:\\Program Files\\AgentTeams\\agentrunner.cmd',
    'C:\\Users\\runner\\.agentteams\\agentrunner.log',
    'C:\\Windows\\System32;C:\\Tools',
  );

  assert.match(content, /\$env:PATH = 'C:\\Windows\\System32;C:\\Tools'/u);
  assert.match(content, /\$env:AGENTTEAMS_DAEMON_TOKEN = 'tok''en'/u);
  assert.match(content, /\$env:AGENTTEAMS_API_URL = 'https:\/\/api\.example'/u);
  assert.match(content, /\$env:CODEX_SANDBOX_LEVEL = 'off'/u);
  assert.match(content, /\$maxLogBytes = 10485760/u);
  assert.match(content, /Move-Item -LiteralPath \$logPath -Destination "\$logPath\.1" -Force/u);
  assert.match(content, /Clear-Content -LiteralPath \$logPath -ErrorAction SilentlyContinue/u);
  assert.match(content, /& 'C:\\Program Files\\AgentTeams\\agentrunner\.cmd' start \*>> '.*agentrunner\.log'/u);
});

test('getAutostartStatus queries Task Scheduler with hidden execution on Windows', () => {
  const calls: Array<{ command: string; windowsHide?: boolean }> = [];
  const status = getAutostartStatus({
    platform: () => 'win32',
    execSync: ((command: string, options?: { windowsHide?: boolean }) => {
      calls.push({ command, windowsHide: options?.windowsHide });
      return Buffer.from('TaskName: AgentRunner');
    }) as typeof import('node:child_process').execSync,
  });

  assert.deepEqual(status, { registered: true, platform: 'task-scheduler' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /schtasks \/Query \/TN "AgentRunner"/u);
  assert.equal(calls[0]!.windowsHide, true);
});

test('registerWindowsTask writes scheduler assets, removes legacy files, and creates and runs the task', async () => {
  const commands: string[] = [];
  const writes: Array<{ path: string; data: string; encoding: BufferEncoding }> = [];
  const removed: string[] = [];

  const result = await registerWindowsTask(
    { token: 'token', apiUrl: 'https://api.example' },
    {
      userId: 'DOMAIN\\runner',
      daemonPath: 'C:\\Tools\\agentrunner.cmd',
      mkdir: async () => undefined,
      writeFile: async (path, data, encoding) => {
        writes.push({ path, data, encoding });
      },
      unlink: async (path) => {
        removed.push(path);
      },
      chmodSync: () => undefined,
      execSync: (command, options) => {
        commands.push(command);
        assert.equal(options.windowsHide, true);
        return Buffer.from('');
      },
    },
  );

  assert.equal(result.platform, 'task-scheduler');
  assert.equal(writes.length, 2);
  assert.ok(writes.some((write) => write.path.endsWith('agentrunner-start.ps1') && write.encoding === 'utf8'));
  assert.ok(writes.some((write) => write.path.endsWith('agentrunner-task.xml') && write.encoding === 'utf16le'));
  assert.ok(removed.some((path) => path.endsWith('agentrunner-start.vbs')));
  assert.ok(removed.some((path) => path.endsWith('agentrunner-restart.vbs')));
  assert.match(commands[0]!, /schtasks \/Delete/u);
  assert.match(commands[1]!, /schtasks \/Create .* \/XML .* \/F/u);
  assert.match(commands[2]!, /schtasks \/Run/u);
});

test('unregisterWindowsTask deletes the task and all generated or legacy artifacts idempotently', async () => {
  const commands: string[] = [];
  const removed: string[] = [];
  await unregisterWindowsTask({
    execSync: (command, options) => {
      commands.push(command);
      assert.equal(options.windowsHide, true);
      return Buffer.from('');
    },
    unlink: async (path) => {
      removed.push(path);
    },
  });

  assert.equal(commands.length, 1);
  assert.match(commands[0]!, /schtasks \/Delete \/TN "AgentRunner" \/F/u);
  assert.ok(removed.some((path) => path.endsWith('agentrunner-task.xml')));
  assert.ok(removed.some((path) => path.endsWith('agentrunner-start.ps1')));
  assert.ok(removed.some((path) => path.endsWith('agentrunner-start.vbs')));
});

test('restartWindowsTask ends the running task before starting it again', async () => {
  const commands: string[] = [];
  await restartWindowsTask(null, {
    execSync: (command, options) => {
      commands.push(command);
      assert.equal(options.windowsHide, true);
      return Buffer.from('');
    },
  });

  assert.deepEqual(commands, ['schtasks /End /TN "AgentRunner"', 'schtasks /Run /TN "AgentRunner"']);
});

test('scheduleWindowsTaskRestart queues a hidden task start after the current action exits', () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  let unrefCalled = false;

  scheduleWindowsTaskRestart({
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { unref: () => (unrefCalled = true) };
    }) as unknown as typeof import('node:child_process').spawn,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, 'powershell.exe');
  assert.match(calls[0]!.args.at(-1) ?? '', /Start-Sleep -Milliseconds 500; schtasks \/Run \/TN 'AgentRunner'/u);
  assert.equal(calls[0]!.options.windowsHide, true);
  assert.equal(calls[0]!.options.detached, true);
  assert.equal(unrefCalled, true);
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

test('launchWindowsHiddenDaemon starts a detached hidden PowerShell process without VBS', () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  let unrefCalled = false;

  launchWindowsHiddenDaemon({
    resolveExecutablePath: () => 'C:\\Tools\\agentrunner.cmd',
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return {
        unref: () => {
          unrefCalled = true;
        },
      };
    }) as typeof import('node:child_process').spawn,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, 'powershell.exe');
  assert.ok(calls[0]!.args.includes('-WindowStyle'));
  assert.ok(calls[0]!.args.includes('Hidden'));
  assert.match(calls[0]!.args.at(-1) ?? '', /agentrunner\.cmd.* start/u);
  assert.equal(calls[0]!.options.windowsHide, true);
  assert.equal(calls[0]!.options.detached, true);
  assert.equal(unrefCalled, true);
});
