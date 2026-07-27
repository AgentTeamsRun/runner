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
  windowsTaskNeedsNativeLauncherMigration,
} from './autostart.js';

const originalPath = process.env.PATH;

test.afterEach(() => {
  mock.restoreAll();
  process.env.PATH = originalPath;
});

test('buildWindowsTaskXmlContent configures supervised hidden logon startup', () => {
  const content = buildWindowsTaskXmlContent(
    'DOMAIN\\runner',
    'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
    'C:\\Users\\runner\\.agentteams\\agentrunner-start.ps1',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );

  assert.match(content, /<LogonTrigger>/u);
  assert.match(content, /<UserId>DOMAIN\\runner<\/UserId>/u);
  assert.match(content, /<Hidden>true<\/Hidden>/u);
  assert.match(content, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(content, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/u);
  assert.match(content, /<Command>.*agentrunner-launcher-0\.0\.107-a1b2c3d4e5f6\.exe<\/Command>/u);
  assert.doesNotMatch(content, /<Command>powershell\.exe<\/Command>/u);
  // The launcher's own argv[0] is separated with an explicit delimiter so a
  // profile path containing a space cannot truncate the child command line.
  assert.match(content, /<Arguments>--exec /u);
  // The first child of the integrity-verified launcher must be an absolute path,
  // not a name resolved through the executable search order.
  assert.match(content, /--exec &quot;C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe&quot; /u);
  assert.match(content, /<WorkingDirectory>C:\\Windows\\System32\\WindowsPowerShell\\v1\.0<\/WorkingDirectory>/u);
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
  assert.match(calls[0]!.command, /schtasks \/Query \/TN "AgentRunner" 2>nul/u);
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
      launcherPath: 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
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
  assert.ok(
    writes.some(
      (write) =>
        write.path.endsWith('agentrunner-task.xml') && write.encoding === 'utf16le' && write.data.startsWith('\uFEFF'),
    ),
  );
  assert.ok(removed.some((path) => path.endsWith('agentrunner-start.vbs')));
  assert.ok(removed.some((path) => path.endsWith('agentrunner-restart.vbs')));
  assert.ok(!commands.some((command) => command.startsWith('schtasks /Delete')));
  assert.ok(commands.some((command) => /schtasks \/Create .* \/XML .* \/F/u.test(command)));
  assert.ok(commands.some((command) => /schtasks \/Run/u.test(command)));
  // chmod cannot restrict a Windows ACL, so the plaintext-token wrapper is locked
  // down with icacls instead.
  assert.ok(
    commands.some(
      (command) =>
        /^icacls ".*agentrunner-start\.ps1" \/inheritance:r/u.test(command) &&
        command.includes('/grant:r "DOMAIN\\runner:(F)"'),
    ),
  );
  // The successful path leaves no rollback backup behind.
  assert.ok(removed.some((path) => path.endsWith('agentrunner-task-backup.xml')));
});

test('registerWindowsTask verifies the live task by ASCII file name so non-ASCII profiles still register', async () => {
  // `schtasks /Query /XML` emits console-code-page bytes. Simulate a CP949 host
  // whose profile directory is `C:\Users\홍길동`: String(Buffer) mangles the path
  // into U+FFFD, but the ASCII launcher file name survives.
  const launcherPath = 'C:\\Users\\홍길동\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe';
  const liveXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-16"?><Task><Actions><Exec><Command>C:\\Users\\\xC8\xAB\xB1\xE6\xB5\xBF\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe</Command></Exec></Actions></Task>`,
    'binary',
  );

  const result = await registerWindowsTask(
    { token: 'token', apiUrl: 'https://api.example' },
    {
      userId: 'DOMAIN\\홍길동',
      daemonPath: 'C:\\Tools\\agentrunner.cmd',
      launcherPath,
      startImmediately: false,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      unlink: async () => undefined,
      chmodSync: () => undefined,
      execSync: (command) => (command.includes('/Query') && command.includes('/XML') ? liveXml : Buffer.from('')),
    },
  );

  assert.equal(result.registered, true);
});

test('registerWindowsTask can repair registration without starting a duplicate runner', async () => {
  const commands: string[] = [];

  await registerWindowsTask(
    { token: 'token', apiUrl: 'https://api.example' },
    {
      userId: 'DOMAIN\\runner',
      daemonPath: 'C:\\Tools\\agentrunner.cmd',
      launcherPath: 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
      startImmediately: false,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      unlink: async () => undefined,
      chmodSync: () => undefined,
      execSync: (command) => {
        commands.push(command);
        return Buffer.from('');
      },
    },
  );

  assert.ok(commands.some((command) => command.startsWith('schtasks /Create')));
  assert.ok(!commands.some((command) => command.startsWith('schtasks /Run')));
});

test('registerWindowsTask restores the previous task from an unmangled backup file when creation fails', async () => {
  const commands: string[] = [];
  const createCommands: string[] = [];

  await assert.rejects(
    registerWindowsTask(
      { token: 'token', apiUrl: 'https://api.example' },
      {
        userId: 'DOMAIN\\runner',
        daemonPath: 'C:\\Tools\\agentrunner.cmd',
        launcherPath: 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
        startImmediately: false,
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        unlink: async () => undefined,
        chmodSync: () => undefined,
        execSync: (command) => {
          commands.push(command);
          if (command.startsWith('schtasks /Create')) {
            createCommands.push(command);
            if (createCommands.length === 1) {
              throw new Error('candidate create failed');
            }
          }
          return Buffer.from('');
        },
      },
    ),
    /candidate create failed/u,
  );

  // The backup is exported by the ScheduledTasks module straight to a UTF-16LE
  // file, so the rollback never round-trips XML through a JS string.
  const backupCommand = commands.find((command) => command.includes('-EncodedCommand'));
  assert.ok(backupCommand, 'the previous task is exported before the candidate /Create');
  const backupScript = Buffer.from(
    backupCommand.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)?.[1] ?? '',
    'base64',
  ).toString('utf16le');
  assert.match(backupScript, /try \{ \$xml = Export-ScheduledTask -TaskName 'AgentRunner' \} catch \{ exit 1 \}/u);
  assert.match(backupScript, /\[Text\.UnicodeEncoding\]::new\(\$false, \$true\)/u);
  assert.match(backupScript, /agentrunner-task-backup\.xml/u);
  // A fresh install has no prior task; its expected failure must not print a
  // CLIXML error blob into the console.
  assert.match(backupScript, /\$ProgressPreference = 'SilentlyContinue'/u);
  assert.match(backupCommand, /-EncodedCommand [A-Za-z0-9+/=]+ 2>nul$/u);

  assert.equal(createCommands.length, 2, 'the second /Create restores the previous XML');
  assert.match(createCommands[1]!, /schtasks \/Create \/TN "AgentRunner" \/XML ".*agentrunner-task-backup\.xml" \/F/u);
  assert.ok(!commands.some((command) => command.startsWith('schtasks /Delete')));
});

test('windowsTaskNeedsNativeLauncherMigration detects a legacy action and stays quiet when unreadable', () => {
  assert.equal(
    windowsTaskNeedsNativeLauncherMigration({
      execSync: () => Buffer.from('<Task><Actions><Exec><Command>powershell.exe</Command></Exec></Actions></Task>'),
    }),
    true,
  );
  assert.equal(
    windowsTaskNeedsNativeLauncherMigration({
      execSync: () =>
        Buffer.from(
          '<Task><Actions><Exec><Command>C:\\x\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe</Command></Exec></Actions></Task>',
        ),
    }),
    false,
  );
  assert.equal(
    windowsTaskNeedsNativeLauncherMigration({
      execSync: () => {
        throw new Error('task not found');
      },
    }),
    false,
  );
});

test('unregisterWindowsTask deletes the task and all generated or legacy artifacts idempotently', async () => {
  const commands: string[] = [];
  const removed: string[] = [];
  await unregisterWindowsTask({
    cleanupLaunchers: async () => undefined,
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

test('restartWindowsTask ends the task, probes its state, then starts it again', async () => {
  const commands: string[] = [];
  await restartWindowsTask(null, {
    execSync: (command, options) => {
      commands.push(command);
      assert.equal(options.windowsHide, true);
      // State 3 (Ready) → confirmed stopped, so the wait loop exits immediately.
      return Buffer.from(/-EncodedCommand/u.test(command) ? '3' : '');
    },
  });

  const schtasksCommands = commands.filter((command) => command.startsWith('schtasks'));
  assert.deepEqual(schtasksCommands, ['schtasks /End /TN "AgentRunner" 2>nul', 'schtasks /Run /TN "AgentRunner"']);
  // A locale-independent state probe runs between End and Run.
  assert.ok(commands.some((command) => /powershell\.exe .*-EncodedCommand/u.test(command)));
});

test('restartWindowsTask waits while the task is still running before starting it again', async () => {
  const commands: string[] = [];
  const sleeps: number[] = [];
  let stateQueries = 0;

  await restartWindowsTask(null, {
    execSync: (command, options) => {
      commands.push(command);
      assert.equal(options.windowsHide, true);
      if (/-EncodedCommand/u.test(command)) {
        stateQueries += 1;
        // State 4 (Running) for the first two probes, then 3 (Ready).
        return Buffer.from(stateQueries < 3 ? '4' : '3');
      }
      return Buffer.from('');
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => 0,
  });

  // Polled twice while the old instance was still running, then ran once stopped.
  assert.equal(sleeps.length, 2);
  assert.equal(stateQueries, 3);
  const schtasksCommands = commands.filter((command) => command.startsWith('schtasks'));
  assert.deepEqual(schtasksCommands, ['schtasks /End /TN "AgentRunner" 2>nul', 'schtasks /Run /TN "AgentRunner"']);
});

test('restartWindowsTask aborts /Run (throws) when the task never reaches a stopped state', async () => {
  const commands: string[] = [];
  let clock = 0;

  await assert.rejects(
    restartWindowsTask(null, {
      execSync: (command) => {
        commands.push(command);
        // Always reports State 4 (Running) — the old instance never stops.
        return Buffer.from(/-EncodedCommand/u.test(command) ? '4' : '');
      },
      sleep: async () => undefined,
      now: () => {
        const value = clock;
        clock += 16_000; // crosses the 30s deadline after two probes
        return value;
      },
    }),
    /did not reach a stopped state/u,
  );

  // /End ran, but /Run must NOT — IgnoreNew would discard it while still running.
  assert.ok(commands.some((command) => command.startsWith('schtasks /End')));
  assert.ok(!commands.some((command) => command.startsWith('schtasks /Run')));
});

test('restartWindowsTask aborts /Run (throws) when the task state cannot be determined', async () => {
  const commands: string[] = [];
  let clock = 0;

  await assert.rejects(
    restartWindowsTask(null, {
      execSync: (command) => {
        commands.push(command);
        // State probe fails → 'unknown'; must not be treated as stopped.
        if (/-EncodedCommand/u.test(command)) {
          throw new Error('COM query failed');
        }
        return Buffer.from('');
      },
      sleep: async () => undefined,
      now: () => {
        const value = clock;
        clock += 16_000;
        return value;
      },
    }),
    /did not reach a stopped state/u,
  );

  assert.ok(!commands.some((command) => command.startsWith('schtasks /Run')));
});

test('scheduleWindowsTaskRestart creates the out-of-job restart helper and verifies its correlated ready marker', async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];

  const scheduled = await scheduleWindowsTaskRestart({
    handoffId: 'active-handoff',
    parentPid: 4321,
    daemonPath: 'C:\\Tools\\agentrunner.cmd',
    launcherPath: 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
    execFileSync: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return Buffer.from('');
    }) as unknown as typeof import('node:child_process').execFileSync,
    readFile: async () =>
      `\uFEFF${JSON.stringify({ handoffId: 'active-handoff', replacementPid: 9876, state: 'prepared' })}`,
    unlink: async () => undefined,
    isProcessRunning: (pid) => pid === 9876,
  });

  assert.equal(scheduled.status, 'prepared');
  assert.equal(scheduled.handoffId, 'active-handoff');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, 'powershell.exe');
  const command = calls[0]!.args.at(-1) ?? '';
  assert.match(command, /Invoke-CimMethod/u);
  assert.match(command, /Win32_Process/u);
  assert.match(command, /MethodName Create/u);
  assert.match(command, /agentrunner-launcher-/u);
  // Same launcher contract as the scheduled task: explicit `--exec` delimiter and
  // an absolute powershell.exe so the verified chain does not depend on PATH.
  assert.match(command, /agentrunner-launcher-[^ ]+\.exe" --exec "[A-Za-z]:\\/u);
  assert.match(command, /WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile/u);
  const encodedCommand = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)?.[1];
  assert.ok(encodedCommand);
  const restartScript = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  assert.match(restartScript, /Set-Content -LiteralPath \$handoffPath/u);
  assert.match(restartScript, /handoffId = \$handoffId; replacementPid = \$PID; state = 'prepared'/u);
  assert.match(restartScript, /state -eq 'acknowledged'/u);
  assert.match(restartScript, /AddSeconds\(180\)/u);
  assert.match(restartScript, /Test-HandoffAcknowledged/u);
  assert.match(restartScript, /schtasks \/Query \/TN \$taskName/u);
  assert.match(restartScript, /for \(\$attempt = 1; \$attempt -le 20; \$attempt\+\+\)/u);
  assert.match(restartScript, /\$task\.State -eq 4/u);
  assert.match(restartScript, /schtasks \/Run \/TN \$taskName/u);
  assert.match(restartScript, /Start-DirectFallback/u);
  assert.match(restartScript, /& \$daemonPath start/u);
  // Every abort/failure path must leave a diagnostic trace in the daemon log so a
  // silent non-recovery is diagnosable (code review P2/P3).
  assert.match(restartScript, /function Write-RestartLog/u);
  assert.match(restartScript, /\*>> \$logPath/u);
  assert.match(restartScript, /trap \{/u);
  // GetTask is wrapped so a TOCTOU deletion is retried instead of crashing silently.
  assert.match(restartScript, /try \{\s*\$task = \$folder\.GetTask\(\$taskName\)\s*\}\s*catch \{/u);
  assert.match(restartScript, /schtasks \/Query failed with exit \$LASTEXITCODE on attempt \$attempt/u);
  assert.match(restartScript, /schtasks \/Run failed with exit \$LASTEXITCODE on attempt \$attempt/u);
  // The outer WMI create logs its ReturnValue on failure.
  assert.match(command, /Win32_Process\.Create failed with ReturnValue/u);
  assert.equal(calls[0]!.options.windowsHide, true);
  // Runs synchronously (blocking) so the helper exists before the daemon exits —
  // must NOT be a detached spawn, which never executes its -Command on Windows.
  assert.notEqual(calls[0]!.options.detached, true);
});

test('scheduleWindowsTaskRestart returns a retryable failure when the helper cannot be created', async () => {
  const scheduled = await scheduleWindowsTaskRestart({
    handoffId: 'create-failure',
    launcherPath: 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
    execFileSync: (() => {
      throw new Error('Win32_Process.Create failed');
    }) as unknown as typeof import('node:child_process').execFileSync,
    unlink: async () => undefined,
  });

  assert.equal(scheduled.status, 'retryable-failure');
  assert.equal(scheduled.handoffId, 'create-failure');
  assert.equal(scheduled.reason, 'helper-preparation-failed');
});

test('scheduleWindowsTaskRestart returns a retryable failure when the launcher cannot be installed', async () => {
  let created = false;

  const scheduled = await scheduleWindowsTaskRestart({
    handoffId: 'launcher-failure',
    installLauncher: async () => {
      throw new Error('The packaged Windows launcher failed SHA-256 verification.');
    },
    execFileSync: (() => {
      created = true;
      return Buffer.from('');
    }) as unknown as typeof import('node:child_process').execFileSync,
    unlink: async () => undefined,
  });

  assert.equal(scheduled.status, 'retryable-failure');
  assert.equal(scheduled.handoffId, 'launcher-failure');
  assert.equal(scheduled.reason, 'helper-preparation-failed');
  assert.match(scheduled.error ?? '', /SHA-256/u);
  assert.equal(created, false, 'no helper is created when the launcher itself is unusable');
});

test('scheduleWindowsTaskRestart rejects a stale ready marker and times out safely', async () => {
  let clock = 0;
  const scheduled = await scheduleWindowsTaskRestart({
    handoffId: 'current-handoff',
    launcherPath: 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.107-a1b2c3d4e5f6.exe',
    execFileSync: (() => Buffer.from('')) as unknown as typeof import('node:child_process').execFileSync,
    readFile: async () => JSON.stringify({ handoffId: 'stale-handoff', replacementPid: 9876, state: 'prepared' }),
    unlink: async () => undefined,
    isProcessRunning: () => true,
    sleep: async () => undefined,
    now: () => {
      const value = clock;
      clock += 3_000;
      return value;
    },
  });

  assert.equal(scheduled.status, 'retryable-failure');
  assert.equal(scheduled.handoffId, 'current-handoff');
  assert.ok(clock >= 20_000, 'Windows helper preparation should allow at least 20 seconds');
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

test('launchWindowsHiddenDaemon starts a hidden PowerShell process without detaching it', () => {
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
  // Must NOT be detached: DETACHED_PROCESS leaves the hidden powershell created
  // but never running its command on Windows, so the runner never starts.
  assert.notEqual(calls[0]!.options.detached, true);
  assert.equal(unrefCalled, true);
});
