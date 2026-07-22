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

test('scheduleWindowsTaskRestart queues an out-of-job task restart after the current action exits', () => {
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
  const command = calls[0]!.args.at(-1) ?? '';
  assert.match(command, /Invoke-CimMethod/u);
  assert.match(command, /Win32_Process/u);
  assert.match(command, /MethodName Create/u);
  const encodedCommand = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)?.[1];
  assert.ok(encodedCommand);
  const restartScript = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  assert.match(restartScript, /schtasks \/Query \/TN \$taskName/u);
  assert.match(restartScript, /do\s*\{/u);
  assert.match(restartScript, /\$task\.State -ne 4/u);
  assert.match(restartScript, /schtasks \/End \/TN \$taskName/u);
  assert.match(restartScript, /schtasks \/Run \/TN \$taskName/u);
  assert.ok(restartScript.indexOf('schtasks /End') < restartScript.indexOf('schtasks /Run'));
  assert.doesNotMatch(restartScript, /Start-Sleep -Milliseconds 500/u);
  // Every abort/failure path must leave a diagnostic trace in the daemon log so a
  // silent non-recovery is diagnosable (code review P2/P3).
  assert.match(restartScript, /function Write-RestartLog/u);
  assert.match(restartScript, /\*>> \$logPath/u);
  assert.match(restartScript, /trap \{/u);
  // GetTask is wrapped so a TOCTOU deletion is logged instead of crashing silently.
  assert.match(restartScript, /try \{\s*\$task = \$folder\.GetTask\(\$taskName\)\s*\}\s*catch \{/u);
  // The 30s deadline and Query-failure branches log before exiting.
  assert.match(restartScript, /after 30s deadline; aborting restart"; exit 1/u);
  assert.match(restartScript, /schtasks \/Query failed .*; aborting restart"; exit 1/u);
  // The outer WMI create logs its ReturnValue on failure.
  assert.match(command, /Win32_Process\.Create failed with ReturnValue/u);
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
