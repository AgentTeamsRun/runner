import { chmodSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readProcessStartTime } from './process-identity.js';

const PID_FILE_PATH = join(homedir(), '.agentteams', 'daemon.pid');

/**
 * A runner instance, not just a PID. Windows reuses PIDs aggressively and a
 * restart that left the previous process alive must never be mistaken for a
 * completed one, so every instance stamps the PID file with an id it generated
 * itself. `instanceId` is null only for a PID file written by a runner that
 * predates instance identity, which had no way to express it.
 */
export type DaemonInstanceRef = {
  pid: number;
  instanceId: string | null;
};

export type DaemonStatus = {
  running: boolean;
  pid: number | null;
  instanceId: string | null;
  /**
   * True once the instance has resolved its runtime configuration and is about
   * to poll. A process that was created but stalled during initialization writes
   * no record at all; one that stalled after writing it stays `ready: false`.
   * Legacy records carry no readiness stamp, so they are reported as ready.
   */
  ready: boolean;
};

export type DaemonPidRecord = {
  pid: number;
  instanceId: string | null;
  startedAt: string | null;
  readyAt: string | null;
};

type PidFileDeps = {
  pidFilePath?: string;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  unlink?: (path: string) => Promise<void>;
  chmodSync?: (path: string, mode: number) => void;
  isProcessRunning?: (pid: number) => boolean;
  processPid?: number;
  now?: () => Date;
  instanceId?: string;
};

let currentInstanceId: string | null = null;

const BYTE_ORDER_MARK = 0xfeff;

/**
 * Parse either format: the JSON record written since instance identity was
 * introduced, or the bare PID that older runners wrote.
 */
export const parseDaemonPidRecord = (content: string): DaemonPidRecord | null => {
  const withoutByteOrderMark = content.charCodeAt(0) === BYTE_ORDER_MARK ? content.slice(1) : content;
  const trimmed = withoutByteOrderMark.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('{')) {
    let parsed: Partial<DaemonPidRecord>;
    try {
      parsed = JSON.parse(trimmed) as Partial<DaemonPidRecord>;
    } catch {
      return null;
    }
    if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      readyAt: typeof parsed.readyAt === 'string' ? parsed.readyAt : null,
    };
  }

  const pid = Number(trimmed);
  return Number.isFinite(pid) && pid > 0 ? { pid, instanceId: null, startedAt: null, readyAt: null } : null;
};

const readRecord = async (deps: PidFileDeps): Promise<DaemonPidRecord | null> => {
  try {
    return parseDaemonPidRecord(await (deps.readFile ?? fs.readFile)(deps.pidFilePath ?? PID_FILE_PATH, 'utf8'));
  } catch {
    return null;
  }
};

const writeRecord = async (record: DaemonPidRecord, deps: PidFileDeps): Promise<void> => {
  const path = deps.pidFilePath ?? PID_FILE_PATH;
  await (deps.mkdir ?? fs.mkdir)(dirname(path), { recursive: true });
  await (deps.writeFile ?? fs.writeFile)(path, JSON.stringify(record), 'utf8');
  (deps.chmodSync ?? chmodSync)(path, 0o600);
};

export const writePidFile = async (deps: PidFileDeps = {}): Promise<void> => {
  const instanceId = deps.instanceId ?? randomUUID();
  currentInstanceId = instanceId;
  await writeRecord(
    {
      pid: deps.processPid ?? process.pid,
      instanceId,
      startedAt: (deps.now?.() ?? new Date()).toISOString(),
      readyAt: null,
    },
    deps,
  );
};

/**
 * Stamp the current instance as initialized. Called once the runtime config is
 * resolved and polling is about to start, so a restart can require an actually
 * usable replacement instead of a process that merely exists.
 */
export const markDaemonReady = async (deps: PidFileDeps = {}): Promise<void> => {
  const pid = deps.processPid ?? process.pid;
  const record = await readRecord(deps);
  const instanceId = record?.instanceId ?? deps.instanceId ?? currentInstanceId;
  if (!record || record.pid !== pid || !instanceId) {
    // Another instance owns the file, or it disappeared — never overwrite it.
    return;
  }
  await writeRecord(
    {
      pid,
      instanceId,
      startedAt: record.startedAt ?? (deps.now?.() ?? new Date()).toISOString(),
      readyAt: (deps.now?.() ?? new Date()).toISOString(),
    },
    deps,
  );
};

export const readPidFile = async (deps: PidFileDeps = {}): Promise<number | null> => {
  return (await readRecord(deps))?.pid ?? null;
};

export const removePidFile = async (deps: PidFileDeps = {}): Promise<void> => {
  try {
    await (deps.unlink ?? fs.unlink)(deps.pidFilePath ?? PID_FILE_PATH);
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

export const getDaemonStatus = async (deps: PidFileDeps = {}): Promise<DaemonStatus> => {
  const record = await readRecord(deps);

  if (record === null) {
    return { running: false, pid: null, instanceId: null, ready: false };
  }

  if ((deps.isProcessRunning ?? isProcessRunning)(record.pid)) {
    return {
      running: true,
      pid: record.pid,
      instanceId: record.instanceId,
      // A legacy record cannot express readiness, so treat its existence as ready.
      ready: record.instanceId === null ? true : record.readyAt !== null,
    };
  }

  // Stale PID file — process no longer exists.
  await removePidFile(deps);
  return { running: false, pid: null, instanceId: null, ready: false };
};

/** True when both references describe the same live runner instance. */
export const isSameDaemonInstance = (a: DaemonInstanceRef | null, b: DaemonInstanceRef | null): boolean => {
  if (!a || !b) {
    return false;
  }
  if (a.instanceId !== null && b.instanceId !== null) {
    return a.instanceId === b.instanceId;
  }
  if (a.instanceId !== b.instanceId) {
    // Exactly one side carries an instance id. A runner that predates instance
    // identity could never write one, so the side that has one cannot be that
    // same process — this is the upgrade's first restart, where a replacement
    // inheriting the old PID would otherwise be mistaken for the old runner.
    return false;
  }
  // Both predate instance identity; PID equality is all we have.
  return a.pid === b.pid;
};

export type RecordedInstanceVerification = 'verified' | 'unverifiable' | 'mismatch';

/**
 * A runner that died without running its cleanup leaves its PID record behind,
 * and Windows reuses PIDs aggressively, so "the recorded PID is alive" does not
 * mean the recorded runner is alive. The recorded process necessarily started
 * *before* its own record was written, while a process that merely inherited
 * the PID started after the original exited — that is, after the record was
 * written. Anything newer than the record is therefore somebody else.
 */
const recordClockSkewToleranceMs = 60_000;

type VerifyInstanceDeps = PidFileDeps & {
  readProcessStartTime?: (pid: number) => Date | null;
};

/**
 * Whether the live process holding `pid` really is the instance the PID file
 * describes. `unverifiable` is the honest answer whenever the record predates
 * `startedAt` or the OS start time cannot be read; only `mismatch` is a licence
 * to treat the record as stale.
 */
export const verifyRecordedDaemonInstance = async (
  pid: number,
  deps: VerifyInstanceDeps = {},
): Promise<RecordedInstanceVerification> => {
  const record = await readRecord(deps);
  if (!record || record.pid !== pid || record.startedAt === null) {
    return 'unverifiable';
  }

  const recordedAt = new Date(record.startedAt);
  if (Number.isNaN(recordedAt.getTime())) {
    return 'unverifiable';
  }

  const startedAt = (deps.readProcessStartTime ?? readProcessStartTime)(pid);
  if (!startedAt) {
    return 'unverifiable';
  }

  return startedAt.getTime() > recordedAt.getTime() + recordClockSkewToleranceMs ? 'mismatch' : 'verified';
};
