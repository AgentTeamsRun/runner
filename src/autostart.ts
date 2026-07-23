import { execFileSync, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveExecutablePath } from './executable.js';
import { logger } from './logger.js';

const SERVICE_LABEL = 'run.agentteams.runner';
const TASK_NAME = 'AgentRunner';
const WINDOWS_LOG_MAX_BYTES = 10 * 1024 * 1024;

// --- Path helpers ---

const getLaunchdPlistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);

const getSystemdServicePath = (): string => join(homedir(), '.config', 'systemd', 'user', 'agentrunner.service');

const getWindowsBatPath = (): string => join(homedir(), '.agentteams', 'agentrunner-start.bat');

const getWindowsVbsPath = (): string => join(homedir(), '.agentteams', 'agentrunner-start.vbs');

const getWindowsRestartVbsPath = (): string => join(homedir(), '.agentteams', 'agentrunner-restart.vbs');

const getWindowsTaskXmlPath = (): string => join(homedir(), '.agentteams', 'agentrunner-task.xml');

const getWindowsWrapperPath = (): string => join(homedir(), '.agentteams', 'agentrunner-start.ps1');

const getWindowsLogPath = (): string => join(homedir(), '.agentteams', 'agentrunner.log');

const getWindowsStartupVbsPath = (): string =>
  join(
    homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'agentrunner-start.vbs',
  );

// --- plist (macOS) ---

export const buildPlistContent = (config: AutostartConfig): string => {
  const nodePath = resolveExecutablePath('node');
  const daemonPath = resolveExecutablePath('agentrunner');

  const currentPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const envEntries = [
    `    <key>PATH</key>\n    <string>${currentPath}</string>`,
    `    <key>AGENTTEAMS_DAEMON_TOKEN</key>\n    <string>${config.token}</string>`,
    `    <key>AGENTTEAMS_API_URL</key>\n    <string>${config.apiUrl}</string>`,
    `    <key>CODEX_SANDBOX_LEVEL</key>\n    <string>off</string>`,
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonPath}</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/tmp/agentrunner.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/agentrunner-error.log</string>
</dict>
</plist>`;
};

// --- systemd (Linux) ---

export const buildSystemdContent = (config: AutostartConfig): string => {
  const daemonPath = resolveExecutablePath('agentrunner');

  return `[Unit]
Description=AgentRunner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${daemonPath} start
Environment="PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}"
Environment="AGENTTEAMS_DAEMON_TOKEN=${config.token}"
Environment="AGENTTEAMS_API_URL=${config.apiUrl}"
Environment="CODEX_SANDBOX_LEVEL=off"
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentrunner

[Install]
WantedBy=default.target`;
};

const escapeForPowerShellString = (value: string): string => value.replaceAll("'", "''");

const escapeForXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export const buildWindowsPowerShellWrapper = (
  config: AutostartConfig,
  daemonPath: string = resolveExecutablePath('agentrunner'),
  logPath: string = getWindowsLogPath(),
  currentPath: string = process.env.PATH ?? '',
): string => {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$env:PATH = '${escapeForPowerShellString(currentPath)}'`,
    `$env:AGENTTEAMS_DAEMON_TOKEN = '${escapeForPowerShellString(config.token)}'`,
    `$env:AGENTTEAMS_API_URL = '${escapeForPowerShellString(config.apiUrl)}'`,
    "$env:CODEX_SANDBOX_LEVEL = 'off'",
    `$logPath = '${escapeForPowerShellString(logPath)}'`,
    `$maxLogBytes = ${WINDOWS_LOG_MAX_BYTES}`,
    'try {',
    '  if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and ((Get-Item -LiteralPath $logPath).Length -ge $maxLogBytes)) {',
    '    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force',
    '  }',
    '} catch {',
    '  Clear-Content -LiteralPath $logPath -ErrorAction SilentlyContinue',
    '}',
    `& '${escapeForPowerShellString(daemonPath)}' start *>> '${escapeForPowerShellString(logPath)}'`,
    'exit $LASTEXITCODE',
  ].join('\r\n');
};

export const buildWindowsTaskXmlContent = (userId: string, wrapperPath: string): string => {
  const escapedUserId = escapeForXml(userId);
  const argumentsValue = escapeForXml(
    `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${wrapperPath}"`,
  );

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>AgentTeams Runner</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapedUserId}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapedUserId}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${argumentsValue}</Arguments>
    </Exec>
  </Actions>
</Task>`;
};

// --- Public API ---

export type AutostartConfig = {
  token: string;
  apiUrl: string;
};

export type AutostartResult = {
  registered: boolean;
  servicePath: string;
  platform: string;
};

const getAutostartConfigFromEnv = (): AutostartConfig | null => {
  const token = process.env.AGENTTEAMS_DAEMON_TOKEN;
  const apiUrl = process.env.AGENTTEAMS_API_URL;
  if (!token || !apiUrl) {
    return null;
  }
  return { token, apiUrl };
};

export const registerAutostart = async (config: AutostartConfig): Promise<AutostartResult> => {
  const os = platform();

  if (os === 'darwin') {
    return registerLaunchd(config);
  }

  if (os === 'linux') {
    return registerSystemd(config);
  }

  if (os === 'win32') {
    return registerWindowsTask(config);
  }

  logger.warn(`Autostart is not supported on '${os}'. Skipping service registration.`);
  return { registered: false, servicePath: '', platform: os };
};

export const unregisterAutostart = async (): Promise<void> => {
  const os = platform();

  if (os === 'darwin') {
    await unregisterLaunchd();
    return;
  }

  if (os === 'linux') {
    await unregisterSystemd();
    return;
  }

  if (os === 'win32') {
    await unregisterWindowsTask();
    return;
  }

  logger.warn(`Autostart is not supported on '${os}'. Nothing to unregister.`);
};

export const restartAutostartService = async (): Promise<void> => {
  const os = platform();
  const config = getAutostartConfigFromEnv();

  if (os === 'darwin') {
    await restartLaunchd(config);
    return;
  }

  if (os === 'linux') {
    await restartSystemd(config);
    return;
  }

  if (os === 'win32') {
    await restartWindowsTask(config);
    return;
  }

  throw new Error(`Autostart restart is not supported on '${os}'.`);
};

type AutostartStatusDeps = {
  platform?: typeof platform;
  execSync?: typeof execSync;
};

export const getAutostartStatus = (deps: AutostartStatusDeps = {}): { registered: boolean; platform: string } => {
  const os = (deps.platform ?? platform)();
  const resolvedExecSync = deps.execSync ?? execSync;

  if (os === 'darwin') {
    try {
      const output = resolvedExecSync(`launchctl list ${SERVICE_LABEL} 2>/dev/null`, {
        encoding: 'utf8',
      });
      return { registered: output.includes(SERVICE_LABEL), platform: 'launchd' };
    } catch {
      return { registered: false, platform: 'launchd' };
    }
  }

  if (os === 'linux') {
    try {
      const output = resolvedExecSync('systemctl --user is-enabled agentrunner 2>/dev/null', {
        encoding: 'utf8',
      });
      return { registered: output.trim() === 'enabled', platform: 'systemd' };
    } catch {
      return { registered: false, platform: 'systemd' };
    }
  }

  if (os === 'win32') {
    try {
      // Suppress schtasks' stderr: an unregistered task makes it print
      // "ERROR: The system cannot find the file specified." which would
      // otherwise leak to the console during `agentrunner restart`.
      resolvedExecSync(`schtasks /Query /TN "${TASK_NAME}" 2>nul`, { windowsHide: true });
      return { registered: true, platform: 'task-scheduler' };
    } catch {
      return { registered: false, platform: 'task-scheduler' };
    }
  }

  return { registered: false, platform: os };
};

// --- macOS launchd ---

const registerLaunchd = async (config: AutostartConfig): Promise<AutostartResult> => {
  const plistPath = getLaunchdPlistPath();

  // Unload if already registered (ignore errors).
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch {
    // Not loaded — that's fine.
  }

  const content = buildPlistContent(config);
  await fs.mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await fs.writeFile(plistPath, content, 'utf8');
  chmodSync(plistPath, 0o600);

  execSync(`launchctl load "${plistPath}"`);

  logger.info('Registered launchd service', { plistPath });
  return { registered: true, servicePath: plistPath, platform: 'launchd' };
};

const unregisterLaunchd = async (): Promise<void> => {
  const plistPath = getLaunchdPlistPath();

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch {
    // Not loaded — that's fine.
  }

  try {
    await fs.unlink(plistPath);
    logger.info('Removed launchd plist', { plistPath });
  } catch {
    // File may not exist.
  }
};

const restartLaunchd = async (config: AutostartConfig | null): Promise<void> => {
  const plistPath = getLaunchdPlistPath();

  if (!existsSync(plistPath)) {
    throw new Error('launchd plist is not registered.');
  }

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch {
    // The agent may already be stopped — continue with load.
  }

  if (config) {
    const content = buildPlistContent(config);
    await fs.writeFile(plistPath, content, 'utf8');
    chmodSync(plistPath, 0o600);
    logger.info('Regenerated launchd plist before restart', { plistPath });
  }

  execSync(`launchctl load "${plistPath}"`);
};

// --- Linux systemd ---

const registerSystemd = async (config: AutostartConfig): Promise<AutostartResult> => {
  const servicePath = getSystemdServicePath();

  const content = buildSystemdContent(config);
  await fs.mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  await fs.writeFile(servicePath, content, 'utf8');
  chmodSync(servicePath, 0o600);

  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable agentrunner');
  execSync('systemctl --user start agentrunner');

  logger.info('Registered systemd user service', { servicePath });
  return { registered: true, servicePath, platform: 'systemd' };
};

const unregisterSystemd = async (): Promise<void> => {
  const servicePath = getSystemdServicePath();

  try {
    execSync('systemctl --user stop agentrunner 2>/dev/null');
  } catch {
    // Not running — that's fine.
  }

  try {
    execSync('systemctl --user disable agentrunner 2>/dev/null');
  } catch {
    // Not enabled — that's fine.
  }

  execSync('systemctl --user daemon-reload');

  try {
    await fs.unlink(servicePath);
    logger.info('Removed systemd service file', { servicePath });
  } catch {
    // File may not exist.
  }
};

const restartSystemd = async (config: AutostartConfig | null): Promise<void> => {
  if (config) {
    const servicePath = getSystemdServicePath();
    const content = buildSystemdContent(config);
    await fs.writeFile(servicePath, content, 'utf8');
    chmodSync(servicePath, 0o600);
    execSync('systemctl --user daemon-reload');
    logger.info('Regenerated systemd service before restart', { servicePath });
  }

  execSync('systemctl --user restart agentrunner');
};

// --- Windows Task Scheduler ---

type WindowsAutostartDeps = {
  execSync?: (command: string, options: { windowsHide: boolean }) => unknown;
  mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  chmodSync?: (path: string, mode: number) => void;
  daemonPath?: string;
  userId?: string;
};

export const registerWindowsTask = async (
  config: AutostartConfig,
  deps: WindowsAutostartDeps = {},
): Promise<AutostartResult> => {
  const resolvedExecSync = deps.execSync ?? execSync;
  const resolvedMkdir = deps.mkdir ?? fs.mkdir;
  const resolvedWriteFile = deps.writeFile ?? fs.writeFile;
  const resolvedUnlink = deps.unlink ?? fs.unlink;
  const resolvedChmodSync = deps.chmodSync ?? chmodSync;
  const taskXmlPath = getWindowsTaskXmlPath();
  const wrapperPath = getWindowsWrapperPath();
  const startupVbsPath = getWindowsStartupVbsPath();
  const legacyVbsPath = getWindowsVbsPath();
  const legacyBatPath = getWindowsBatPath();
  const restartVbsPath = getWindowsRestartVbsPath();

  await resolvedMkdir(dirname(taskXmlPath), { recursive: true });

  // Remove legacy Task Scheduler entry if any.
  try {
    resolvedExecSync(`schtasks /Delete /TN "${TASK_NAME}" /F 2>nul`, { windowsHide: true });
  } catch {
    // Not registered — that's fine.
  }

  const userName = process.env.USERNAME ?? process.env.USER ?? '';
  const userId = deps.userId ?? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userName}` : userName);
  if (!userId) {
    throw new Error('Cannot register Windows Task Scheduler autostart: current user is unknown.');
  }

  await resolvedWriteFile(
    wrapperPath,
    buildWindowsPowerShellWrapper(config, deps.daemonPath ?? resolveExecutablePath('agentrunner')),
    'utf8',
  );
  await resolvedWriteFile(taskXmlPath, buildWindowsTaskXmlContent(userId, wrapperPath), 'utf16le');
  resolvedChmodSync(wrapperPath, 0o600);
  resolvedChmodSync(taskXmlPath, 0o600);

  // Clean up legacy files.
  for (const legacyPath of [startupVbsPath, legacyVbsPath, legacyBatPath, restartVbsPath]) {
    try {
      await resolvedUnlink(legacyPath);
    } catch {
      // Legacy file may not exist.
    }
  }

  resolvedExecSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${taskXmlPath}" /F`, { windowsHide: true });

  // Start the registered task immediately.
  try {
    resolvedExecSync(`schtasks /Run /TN "${TASK_NAME}"`, { windowsHide: true });
  } catch {
    logger.warn('Autostart registered but immediate start failed. It will start at next logon.');
  }

  logger.info('Registered Windows Task Scheduler autostart', { taskXmlPath });
  return { registered: true, servicePath: taskXmlPath, platform: 'task-scheduler' };
};

export const unregisterWindowsTask = async (deps: WindowsAutostartDeps = {}): Promise<void> => {
  const resolvedExecSync = deps.execSync ?? execSync;
  const resolvedUnlink = deps.unlink ?? fs.unlink;
  const startupVbsPath = getWindowsStartupVbsPath();
  const legacyVbsPath = getWindowsVbsPath();
  const legacyBatPath = getWindowsBatPath();
  const restartVbsPath = getWindowsRestartVbsPath();
  const taskXmlPath = getWindowsTaskXmlPath();
  const wrapperPath = getWindowsWrapperPath();

  // Remove legacy Task Scheduler entry if any.
  try {
    resolvedExecSync(`schtasks /Delete /TN "${TASK_NAME}" /F 2>nul`, { windowsHide: true });
  } catch {
    // Not registered — that's fine.
  }

  // Remove Startup folder VBS and legacy files.
  for (const filePath of [startupVbsPath, legacyVbsPath, legacyBatPath, restartVbsPath, taskXmlPath, wrapperPath]) {
    try {
      await resolvedUnlink(filePath);
      logger.info('Removed autostart file', { filePath });
    } catch {
      // File may not exist.
    }
  }
};

// Schedule.Service task states — 4 means the task is currently running.
const TASK_STATE_RUNNING = 4;
const taskStopPollIntervalMs = 250;
const taskStopDeadlineMs = 30_000;

type WindowsTaskExecSync = (command: string, options: { windowsHide: boolean }) => unknown;

// Build a locale-independent task-state probe. Parsing `schtasks /Query` output
// is unreliable because the Status column is localized (e.g. "실행 중" on Korean
// Windows), so read the numeric State via the Schedule.Service COM object and
// pass it as an EncodedCommand to sidestep all shell-quoting concerns.
export const buildWindowsTaskStateQueryCommand = (): string => {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$service = New-Object -ComObject 'Schedule.Service'",
    '$service.Connect()',
    `try { ($service.GetFolder('\\').GetTask('${TASK_NAME}')).State } catch { -1 }`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
};

type WindowsTaskState = 'running' | 'stopped' | 'unknown';

// Probe the task state as a tri-state. Crucially, a failed COM/PowerShell query
// is 'unknown' — NOT 'stopped'. Treating a query error as stopped would let the
// caller fire `/Run` while the old instance is possibly still alive, and
// MultipleInstancesPolicy=IgnoreNew would silently discard it.
const getWindowsTaskState = (execSyncFn: WindowsTaskExecSync): WindowsTaskState => {
  let output: string;
  try {
    output = String(execSyncFn(buildWindowsTaskStateQueryCommand(), { windowsHide: true })).trim();
  } catch {
    return 'unknown';
  }
  const state = Number.parseInt(output, 10);
  if (!Number.isFinite(state) || state < 0) {
    return 'unknown';
  }
  return state === TASK_STATE_RUNNING ? 'running' : 'stopped';
};

type RestartWindowsTaskDeps = {
  execSync?: WindowsTaskExecSync;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  chmodSync?: (path: string, mode: number) => void;
  daemonPath?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export const restartWindowsTask = async (
  config: AutostartConfig | null,
  deps: RestartWindowsTaskDeps = {},
): Promise<void> => {
  const resolvedExecSync = deps.execSync ?? execSync;
  const resolvedSleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const resolvedNow = deps.now ?? (() => Date.now());
  if (config) {
    const wrapperPath = getWindowsWrapperPath();
    await (deps.writeFile ?? fs.writeFile)(
      wrapperPath,
      buildWindowsPowerShellWrapper(config, deps.daemonPath ?? resolveExecutablePath('agentrunner')),
      'utf8',
    );
    (deps.chmodSync ?? chmodSync)(wrapperPath, 0o600);
    logger.info('Regenerated Windows task wrapper before restart', { wrapperPath });
  }

  try {
    // A task that isn't currently running makes schtasks /End emit an error to
    // stderr; suppress it since we ignore the failure and continue anyway.
    resolvedExecSync(`schtasks /End /TN "${TASK_NAME}" 2>nul`, { windowsHide: true });
  } catch {
    // The task may already be stopped — continue with an explicit run.
  }

  // `schtasks /End` only *signals* termination; the instance keeps running for a
  // moment. The task uses MultipleInstancesPolicy=IgnoreNew, so a `/Run` fired
  // while the old instance is still alive is silently discarded — leaving the
  // runner stopped. Wait until the task is confirmed stopped before starting it.
  const stopDeadline = resolvedNow() + taskStopDeadlineMs;
  let taskState = getWindowsTaskState(resolvedExecSync);
  while (taskState !== 'stopped' && resolvedNow() < stopDeadline) {
    await resolvedSleep(taskStopPollIntervalMs);
    taskState = getWindowsTaskState(resolvedExecSync);
  }

  if (taskState !== 'stopped') {
    // Still running or the state is unverifiable. Firing `/Run` now would be
    // discarded by IgnoreNew and falsely report success, so fail loudly instead
    // so the caller (CLI/restart) surfaces a non-zero result.
    throw new Error(
      `AgentRunner task did not reach a stopped state before restart (last state: ${taskState}); ` +
        'aborting /Run to avoid a silent IgnoreNew discard.',
    );
  }

  resolvedExecSync(`schtasks /Run /TN "${TASK_NAME}"`, { windowsHide: true });
};

type ScheduleWindowsTaskRestartDeps = {
  execFileSync?: typeof execFileSync;
};

// Task Scheduler keeps every process spawned by an action in the same Job Object.
// Ask WMI to create the restart helper outside that Job so IgnoreNew cannot discard
// the explicit start while this daemon is exiting.
//
// Returns whether the helper was created. Callers MUST NOT exit the daemon when
// this returns false — doing so would terminate the current runner with no
// replacement coming up.
export const scheduleWindowsTaskRestart = (deps: ScheduleWindowsTaskRestartDeps = {}): boolean => {
  const runSync = deps.execFileSync ?? execFileSync;
  const logPath = getWindowsLogPath();
  // Every failure path appends a diagnostic line to the daemon log so a restart
  // that never brings the runner back up leaves a trace instead of dying silently.
  const restartScript = `
$taskName = '${TASK_NAME}'
$logPath = '${escapeForPowerShellString(logPath)}'
function Write-RestartLog($message) {
  try { "[web-restart] $((Get-Date).ToString('s')) $message" *>> $logPath } catch { }
}
trap { Write-RestartLog "unhandled error during restart: $($_.Exception.Message)"; exit 1 }
$deadline = (Get-Date).AddSeconds(30)
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\\')
do {
  schtasks /Query /TN $taskName *> $null
  if ($LASTEXITCODE -ne 0) { Write-RestartLog "schtasks /Query failed with exit $LASTEXITCODE; aborting restart"; exit 1 }
  try {
    $task = $folder.GetTask($taskName)
  } catch {
    Write-RestartLog "GetTask threw before restart: $($_.Exception.Message); aborting restart"
    exit 1
  }
  if ($task.State -ne 4) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if ($task.State -eq 4) { Write-RestartLog "task still running after 30s deadline; aborting restart"; exit 1 }
schtasks /End /TN $taskName *>> $logPath
schtasks /Run /TN $taskName *>> $logPath
if ($LASTEXITCODE -ne 0) { Write-RestartLog "schtasks /Run failed with exit $LASTEXITCODE"; exit $LASTEXITCODE }
Write-RestartLog "restart triggered successfully"
`.trim();
  const encodedRestartScript = Buffer.from(restartScript, 'utf16le').toString('base64');
  const restartCommandLine =
    `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ` +
    `-EncodedCommand ${encodedRestartScript}`;
  const createCommand =
    `$logPath = '${escapeForPowerShellString(logPath)}'; ` +
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
    `-Arguments @{ CommandLine = '${escapeForPowerShellString(restartCommandLine)}' }; ` +
    `if ($result.ReturnValue -ne 0) { ` +
    `try { "[web-restart] $((Get-Date).ToString('s')) Win32_Process.Create failed with ReturnValue $($result.ReturnValue)" *>> $logPath } catch { }; ` +
    `exit $result.ReturnValue }`;
  // Run the WMI create SYNCHRONOUSLY. A detached `spawn(..., { detached: true })`
  // never executes its -Command on Windows (DETACHED_PROCESS leaves powershell
  // created but idle), and a non-detached async spawn would race this daemon's
  // own exit / Task Scheduler job teardown. Blocking here guarantees the helper
  // — created by WMI, so it lives outside this task's Job Object — exists before
  // the daemon exits. The helper itself keeps running independently afterwards.
  try {
    runSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        createCommand,
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      },
    );
    return true;
  } catch (error) {
    logger.warn('Failed to schedule Windows task restart helper', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

// --- Windows hidden launcher (manual, unregistered start) ---

type LaunchWindowsHiddenDeps = {
  spawn?: typeof spawn;
  resolveExecutablePath?: typeof resolveExecutablePath;
};

export const launchWindowsHiddenDaemon = (deps: LaunchWindowsHiddenDeps = {}): void => {
  const resolvedSpawn = deps.spawn ?? spawn;
  const daemonPath = (deps.resolveExecutablePath ?? resolveExecutablePath)('agentrunner');
  const command = `& '${escapeForPowerShellString(daemonPath)}' start`;
  // NOTE: do NOT pass `detached: true` here. On Windows that sets the
  // DETACHED_PROCESS creation flag, and spawning powershell.exe that way (with
  // stdio ignored) leaves it created but never running its `-Command` — the
  // runner silently never starts. Windows does not terminate child processes
  // when the parent exits, so `windowsHide` + `unref()` already lets the hidden
  // runner keep running in the background after this CLI process is gone.
  const child = resolvedSpawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
};
