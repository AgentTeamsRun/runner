import { chmodSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isProcessRunning } from './pid.js';

export const restartHandoffIdEnv = 'AGENTTEAMS_RESTART_HANDOFF_ID';
export const restartHandoffParentPidEnv = 'AGENTTEAMS_RESTART_PARENT_PID';
export const restartHandoffPathEnv = 'AGENTTEAMS_RESTART_HANDOFF_PATH';

export type RestartHandoffFailureReason =
  | 'autostart-repair-failed'
  | 'helper-preparation-failed'
  | 'replacement-preparation-failed'
  | 'acknowledgement-failed'
  | 'replacement-confirmation-failed';

export type RestartHandoffPrepared = {
  status: 'prepared';
  handoffId: string;
  markerPath: string;
  replacementPid: number;
  replacementReady: true;
  acknowledged: false;
  retryableFailure: false;
};

export type RestartHandoffRetryableFailure = {
  status: 'retryable-failure';
  handoffId: string;
  replacementReady: false;
  acknowledged: false;
  retryableFailure: true;
  reason: RestartHandoffFailureReason;
  error: string;
};

export type RestartHandoffPreparation = RestartHandoffPrepared | RestartHandoffRetryableFailure;

export type RestartExecutionResult =
  | {
      status: 'acknowledged';
      handoffId: string;
      replacementReady: true;
      acknowledged: true;
      retryableFailure: false;
    }
  | RestartHandoffRetryableFailure;

export type RestartHandoffLaunch = {
  handoffId: string;
  parentPid: number;
  markerPath: string;
};

type RestartHandoffMarker = {
  handoffId: string;
  replacementPid: number;
  state: 'prepared' | 'acknowledged';
};

type WaitForPreparedHandoffDeps = {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  isProcessRunning?: (pid: number) => boolean;
  timeoutMs?: number;
};

type ActivateRestartHandoffDeps = {
  env?: NodeJS.ProcessEnv;
  mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  chmodSync?: (path: string, mode: number) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  isProcessRunning?: (pid: number) => boolean;
  processPid?: number;
  timeoutMs?: number;
};

type AcknowledgePreparedRestartHandoffDeps = {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  chmodSync?: (path: string, mode: number) => void;
  isProcessRunning?: (pid: number) => boolean;
};

const handoffPollIntervalMs = 50;
const handoffPreparationTimeoutMs = 5_000;
export const restartHandoffAcknowledgementTimeoutMs = 180_000;
const parentExitGraceTimeoutMs = 5_000;

export const getRestartHandoffPath = (handoffId?: string): string =>
  join(homedir(), '.agentteams', handoffId ? `restart-handoff-${handoffId}.json` : 'restart-handoff.json');

export const buildRestartHandoffEnv = (
  launch: RestartHandoffLaunch,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...baseEnv,
  [restartHandoffIdEnv]: launch.handoffId,
  [restartHandoffParentPidEnv]: String(launch.parentPid),
  [restartHandoffPathEnv]: launch.markerPath,
});

const parseMarker = (content: string): RestartHandoffMarker | null => {
  try {
    const marker = JSON.parse(content.replace(/^\uFEFF/u, '')) as Partial<RestartHandoffMarker>;
    if (
      typeof marker.handoffId !== 'string' ||
      typeof marker.replacementPid !== 'number' ||
      (marker.state !== 'prepared' && marker.state !== 'acknowledged')
    ) {
      return null;
    }
    return marker as RestartHandoffMarker;
  } catch {
    return null;
  }
};

export const waitForPreparedRestartHandoff = async (
  launch: RestartHandoffLaunch,
  deps: WaitForPreparedHandoffDeps = {},
): Promise<RestartHandoffPreparation> => {
  const readFile = deps.readFile ?? fs.readFile;
  const sleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const now = deps.now ?? (() => Date.now());
  const processIsRunning = deps.isProcessRunning ?? isProcessRunning;
  const deadline = now() + (deps.timeoutMs ?? handoffPreparationTimeoutMs);

  while (now() < deadline) {
    try {
      const marker = parseMarker(await readFile(launch.markerPath, 'utf8'));
      if (
        marker?.handoffId === launch.handoffId &&
        processIsRunning(marker.replacementPid) &&
        marker.replacementPid !== launch.parentPid
      ) {
        return {
          status: 'prepared',
          handoffId: launch.handoffId,
          markerPath: launch.markerPath,
          replacementPid: marker.replacementPid,
          replacementReady: true,
          acknowledged: false,
          retryableFailure: false,
        };
      }
    } catch {
      // The replacement may not have written its marker yet.
    }
    await sleep(handoffPollIntervalMs);
  }

  return {
    status: 'retryable-failure',
    handoffId: launch.handoffId,
    replacementReady: false,
    acknowledged: false,
    retryableFailure: true,
    reason: 'replacement-preparation-failed',
    error: 'Timed out waiting for the replacement runner readiness marker.',
  };
};

const parseRestartHandoffLaunch = (env: NodeJS.ProcessEnv): RestartHandoffLaunch | null => {
  const handoffId = env[restartHandoffIdEnv];
  const parentPid = Number(env[restartHandoffParentPidEnv]);
  const markerPath = env[restartHandoffPathEnv];

  if (!handoffId || !markerPath || !Number.isInteger(parentPid) || parentPid <= 0) {
    return null;
  }
  return { handoffId, parentPid, markerPath };
};

const markerBelongsToHandoff = (
  marker: RestartHandoffMarker | null,
  handoffId: string,
  replacementPid: number,
): marker is RestartHandoffMarker => marker?.handoffId === handoffId && marker.replacementPid === replacementPid;

const removeMarkerIfOwned = async (
  markerPath: string,
  handoffId: string,
  replacementPid: number,
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>,
  unlink: (path: string) => Promise<void>,
): Promise<void> => {
  try {
    const marker = parseMarker(await readFile(markerPath, 'utf8'));
    if (markerBelongsToHandoff(marker, handoffId, replacementPid)) {
      await unlink(markerPath);
    }
  } catch {
    // The marker may already be gone or temporarily unavailable.
  }
};

export const acknowledgePreparedRestartHandoff = async (
  preparation: RestartHandoffPrepared,
  deps: AcknowledgePreparedRestartHandoffDeps = {},
): Promise<boolean> => {
  const readFile = deps.readFile ?? fs.readFile;
  const writeFile = deps.writeFile ?? fs.writeFile;
  const setMode = deps.chmodSync ?? chmodSync;
  const processIsRunning = deps.isProcessRunning ?? isProcessRunning;

  try {
    const marker = parseMarker(await readFile(preparation.markerPath, 'utf8'));
    if (
      !markerBelongsToHandoff(marker, preparation.handoffId, preparation.replacementPid) ||
      marker.state !== 'prepared' ||
      !processIsRunning(preparation.replacementPid)
    ) {
      return false;
    }

    await writeFile(
      preparation.markerPath,
      JSON.stringify({ ...marker, state: 'acknowledged' } satisfies RestartHandoffMarker),
      'utf8',
    );
    setMode(preparation.markerPath, 0o600);
    return processIsRunning(preparation.replacementPid);
  } catch {
    return false;
  }
};

export const activatePreparedRestartHandoff = async (deps: ActivateRestartHandoffDeps = {}): Promise<boolean> => {
  const launch = parseRestartHandoffLaunch(deps.env ?? process.env);
  if (!launch) {
    return false;
  }

  const mkdir = deps.mkdir ?? fs.mkdir;
  const readFile = deps.readFile ?? fs.readFile;
  const writeFile = deps.writeFile ?? fs.writeFile;
  const unlink = deps.unlink ?? fs.unlink;
  const setMode = deps.chmodSync ?? chmodSync;
  const sleep = deps.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const now = deps.now ?? (() => Date.now());
  const processIsRunning = deps.isProcessRunning ?? isProcessRunning;
  const replacementPid = deps.processPid ?? process.pid;
  const acknowledgementDeadline = now() + (deps.timeoutMs ?? restartHandoffAcknowledgementTimeoutMs);

  await mkdir(dirname(launch.markerPath), { recursive: true });
  await writeFile(
    launch.markerPath,
    JSON.stringify({
      handoffId: launch.handoffId,
      replacementPid,
      state: 'prepared',
    } satisfies RestartHandoffMarker),
    'utf8',
  );
  setMode(launch.markerPath, 0o600);

  let isAcknowledged = false;
  while (now() < acknowledgementDeadline) {
    try {
      const marker = parseMarker(await readFile(launch.markerPath, 'utf8'));
      if (marker && !markerBelongsToHandoff(marker, launch.handoffId, replacementPid)) {
        throw new Error(`Restart handoff ${launch.handoffId} was superseded before acknowledgement.`);
      }
      if (marker?.state === 'acknowledged') {
        isAcknowledged = true;
        break;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('superseded')) {
        throw error;
      }
      // The parent may be replacing the marker contents with the acknowledged state.
    }
    await sleep(handoffPollIntervalMs);
  }

  if (!isAcknowledged) {
    await removeMarkerIfOwned(launch.markerPath, launch.handoffId, replacementPid, readFile, unlink);
    throw new Error(`Restart handoff ${launch.handoffId} timed out waiting for acknowledgement.`);
  }

  const parentExitGraceDeadline = now() + parentExitGraceTimeoutMs;
  while (processIsRunning(launch.parentPid) && now() < parentExitGraceDeadline) {
    await sleep(handoffPollIntervalMs);
  }

  await removeMarkerIfOwned(launch.markerPath, launch.handoffId, replacementPid, readFile, unlink);
  return true;
};

export const isCurrentPreparedHandoff = (
  result: RestartHandoffPreparation,
  expectedHandoffId: string,
): result is RestartHandoffPrepared => {
  return result.status === 'prepared' && result.handoffId === expectedHandoffId;
};
