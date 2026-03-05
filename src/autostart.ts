import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.js";

const SERVICE_LABEL = "run.agentteams.daemon";
const TASK_NAME = "AgentTeamsDaemon";

// --- Path helpers ---

const getLaunchdPlistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);

const getSystemdServicePath = (): string =>
  join(homedir(), ".config", "systemd", "user", "agentteams-daemon.service");

const getWindowsBatPath = (): string =>
  join(homedir(), ".agentteams", "daemon-start.bat");

const resolveExecutablePath = (name: string): string => {
  const os = platform();
  const cmd = os === "win32" ? `where ${name}` : `which ${name}`;

  try {
    const output = execSync(cmd, { encoding: "utf8" }).trim();
    // `where` on Windows can return multiple lines — take the first.
    return output.split(/\r?\n/)[0];
  } catch {
    throw new Error(
      `Cannot find '${name}' in PATH. Ensure it is installed and available globally.`
    );
  }
};

// --- plist (macOS) ---

const buildPlistContent = (config: AutostartConfig): string => {
  const nodePath = resolveExecutablePath("node");
  const daemonPath = resolveExecutablePath("agentteams-daemon");

  const envEntries = [
    `    <key>AGENTTEAMS_DAEMON_TOKEN</key>\n    <string>${config.token}</string>`,
    `    <key>AGENTTEAMS_API_URL</key>\n    <string>${config.apiUrl}</string>`,
  ].join("\n");

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
  <string>/tmp/agentteams-daemon.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/agentteams-daemon-error.log</string>
</dict>
</plist>`;
};

// --- systemd (Linux) ---

const buildSystemdContent = (config: AutostartConfig): string => {
  const daemonPath = resolveExecutablePath("agentteams-daemon");

  return `[Unit]
Description=AgentTeams Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${daemonPath} start
Environment="AGENTTEAMS_DAEMON_TOKEN=${config.token}"
Environment="AGENTTEAMS_API_URL=${config.apiUrl}"
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentteams-daemon

[Install]
WantedBy=default.target`;
};

// --- bat (Windows) ---

const buildWindowsBatContent = (config: AutostartConfig): string => {
  const daemonPath = resolveExecutablePath("agentteams-daemon");

  return `@echo off
set AGENTTEAMS_DAEMON_TOKEN=${config.token}
set AGENTTEAMS_API_URL=${config.apiUrl}
"${daemonPath}" start
`;
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

export const registerAutostart = async (config: AutostartConfig): Promise<AutostartResult> => {
  const os = platform();

  if (os === "darwin") {
    return registerLaunchd(config);
  }

  if (os === "linux") {
    return registerSystemd(config);
  }

  if (os === "win32") {
    return registerWindowsTask(config);
  }

  logger.warn(`Autostart is not supported on '${os}'. Skipping service registration.`);
  return { registered: false, servicePath: "", platform: os };
};

export const unregisterAutostart = async (): Promise<void> => {
  const os = platform();

  if (os === "darwin") {
    await unregisterLaunchd();
    return;
  }

  if (os === "linux") {
    await unregisterSystemd();
    return;
  }

  if (os === "win32") {
    await unregisterWindowsTask();
    return;
  }

  logger.warn(`Autostart is not supported on '${os}'. Nothing to unregister.`);
};

export const getAutostartStatus = (): { registered: boolean; platform: string } => {
  const os = platform();

  if (os === "darwin") {
    try {
      const output = execSync(`launchctl list ${SERVICE_LABEL} 2>/dev/null`, {
        encoding: "utf8",
      });
      return { registered: output.includes(SERVICE_LABEL), platform: "launchd" };
    } catch {
      return { registered: false, platform: "launchd" };
    }
  }

  if (os === "linux") {
    try {
      const output = execSync("systemctl --user is-enabled agentteams-daemon 2>/dev/null", {
        encoding: "utf8",
      });
      return { registered: output.trim() === "enabled", platform: "systemd" };
    } catch {
      return { registered: false, platform: "systemd" };
    }
  }

  if (os === "win32") {
    try {
      const output = execSync(`schtasks /Query /TN "${TASK_NAME}" 2>nul`, {
        encoding: "utf8",
      });
      return { registered: output.includes(TASK_NAME), platform: "task-scheduler" };
    } catch {
      return { registered: false, platform: "task-scheduler" };
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
  await fs.mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await fs.writeFile(plistPath, content, "utf8");

  execSync(`launchctl load "${plistPath}"`);

  logger.info("Registered launchd service", { plistPath });
  return { registered: true, servicePath: plistPath, platform: "launchd" };
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
    logger.info("Removed launchd plist", { plistPath });
  } catch {
    // File may not exist.
  }
};

// --- Linux systemd ---

const registerSystemd = async (config: AutostartConfig): Promise<AutostartResult> => {
  const servicePath = getSystemdServicePath();

  const content = buildSystemdContent(config);
  await fs.mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  await fs.writeFile(servicePath, content, "utf8");

  execSync("systemctl --user daemon-reload");
  execSync("systemctl --user enable agentteams-daemon");
  execSync("systemctl --user start agentteams-daemon");

  logger.info("Registered systemd user service", { servicePath });
  return { registered: true, servicePath, platform: "systemd" };
};

const unregisterSystemd = async (): Promise<void> => {
  const servicePath = getSystemdServicePath();

  try {
    execSync("systemctl --user stop agentteams-daemon 2>/dev/null");
  } catch {
    // Not running — that's fine.
  }

  try {
    execSync("systemctl --user disable agentteams-daemon 2>/dev/null");
  } catch {
    // Not enabled — that's fine.
  }

  execSync("systemctl --user daemon-reload");

  try {
    await fs.unlink(servicePath);
    logger.info("Removed systemd service file", { servicePath });
  } catch {
    // File may not exist.
  }
};

// --- Windows Task Scheduler ---

const registerWindowsTask = async (config: AutostartConfig): Promise<AutostartResult> => {
  const batPath = getWindowsBatPath();

  // Remove existing task if any.
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F 2>nul`);
  } catch {
    // Not registered — that's fine.
  }

  const content = buildWindowsBatContent(config);
  await fs.mkdir(join(homedir(), ".agentteams"), { recursive: true });
  await fs.writeFile(batPath, content, "utf8");

  // Register task to run at user logon.
  execSync(
    `schtasks /Create /TN "${TASK_NAME}" /TR "\\"${batPath}\\"" /SC ONLOGON /RL HIGHEST /F`
  );

  // Start the task immediately.
  try {
    execSync(`schtasks /Run /TN "${TASK_NAME}"`);
  } catch {
    logger.warn("Task registered but immediate start failed. It will start at next logon.");
  }

  logger.info("Registered Windows Task Scheduler task", { batPath });
  return { registered: true, servicePath: batPath, platform: "task-scheduler" };
};

const unregisterWindowsTask = async (): Promise<void> => {
  const batPath = getWindowsBatPath();

  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F 2>nul`);
    logger.info("Removed Windows scheduled task");
  } catch {
    // Not registered — that's fine.
  }

  try {
    await fs.unlink(batPath);
    logger.info("Removed daemon start script", { batPath });
  } catch {
    // File may not exist.
  }
};
