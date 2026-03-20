import { chmodSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PID_FILE_PATH = join(homedir(), ".agentteams", "daemon.pid");

export const writePidFile = async (): Promise<void> => {
  await fs.mkdir(dirname(PID_FILE_PATH), { recursive: true });
  await fs.writeFile(PID_FILE_PATH, String(process.pid), "utf8");
  chmodSync(PID_FILE_PATH, 0o600);
};

export const readPidFile = async (): Promise<number | null> => {
  try {
    const content = await fs.readFile(PID_FILE_PATH, "utf8");
    const pid = Number(content.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const removePidFile = async (): Promise<void> => {
  try {
    await fs.unlink(PID_FILE_PATH);
  } catch {
    // File may not exist — that's fine.
  }
};

export const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const getDaemonStatus = async (): Promise<{ running: boolean; pid: number | null }> => {
  const pid = await readPidFile();

  if (pid === null) {
    return { running: false, pid: null };
  }

  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }

  // Stale PID file — process no longer exists.
  await removePidFile();
  return { running: false, pid: null };
};
