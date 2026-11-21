import assert from 'node:assert/strict';
import test from 'node:test';
import type { WindowsStopOutcome } from '../daemon-stop.js';
import { runStopCommand } from './stop.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// POSIX 경로: SIGTERM이 러너의 종료 핸들러를 실행하므로 신호만 보내고 기록을 지운다. 이 동작은 바뀌지 않는다.
test('runStopCommand signals the daemon and removes the record outside Windows', async () => {
  const events: string[] = [];
  await runStopCommand({
    platform: () => 'linux',
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: null, ready: true }),
    kill: (pid, signal) => {
      events.push(`kill:${pid}:${String(signal)}`);
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    verifyRecordedDaemonInstance: async () => 'verified',
    stopWindowsDaemonInstance: async () => assert.fail('the Windows stop path must not run outside Windows'),
    logger: silentLogger,
  });

  assert.deepEqual(events, ['kill:4321:SIGTERM', 'pid-remove']);
});

test('runStopCommand does not signal a process that reused the recorded runner PID outside Windows', async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  await runStopCommand({
    platform: () => 'linux',
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: 'old', ready: true }),
    verifyRecordedDaemonInstance: async () => 'mismatch',
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: { ...silentLogger, warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(events, ['pid-remove']);
  assert.equal(warnings.length, 1);
});

test('runStopCommand still signals a runner whose identity cannot be verified outside Windows', async () => {
  const events: string[] = [];
  await runStopCommand({
    platform: () => 'darwin',
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: null, ready: true }),
    verifyRecordedDaemonInstance: async () => 'unverifiable',
    kill: () => {
      events.push('kill');
      return true;
    },
    removePidFile: async () => {
      events.push('pid-remove');
    },
    logger: silentLogger,
  });

  assert.deepEqual(events, ['kill', 'pid-remove']);
});

const runWindowsStop = async (
  outcome: WindowsStopOutcome | Error,
): Promise<{ events: string[]; warnings: string[]; error: unknown }> => {
  const events: string[] = [];
  const warnings: string[] = [];
  let error: unknown = null;
  try {
    await runStopCommand({
      platform: () => 'win32',
      getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: 'instance', ready: true }),
      // Windows의 SIGTERM은 TerminateProcess다. 러너를 직접 죽이는 경로가 남아 있으면 안 된다.
      kill: () => assert.fail('the Windows stop path must never signal the runner directly'),
      removePidFile: async () => {
        events.push('pid-remove');
      },
      verifyRecordedDaemonInstance: async () => 'verified',
      stopWindowsDaemonInstance: async (pid) => {
        events.push(`stop:${pid}`);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      logger: { ...silentLogger, warn: (message) => warnings.push(message) },
    });
  } catch (caught) {
    error = caught;
  }
  return { events, warnings, error };
};

test('runStopCommand on Windows waits for a graceful stop and then removes the record', async () => {
  const { events, warnings, error } = await runWindowsStop({ status: 'graceful', pid: 4321 });

  assert.equal(error, null);
  assert.deepEqual(events, ['stop:4321', 'pid-remove']);
  assert.deepEqual(warnings, []);
});

test('runStopCommand on Windows reports a forced stop as a warning, not as a graceful one', async () => {
  const { events, warnings, error } = await runWindowsStop({ status: 'forced', pid: 4321, reason: 'no-channel' });

  assert.equal(error, null);
  assert.deepEqual(events, ['stop:4321', 'pid-remove']);
  assert.equal(warnings.length, 1);
});

test('runStopCommand on Windows leaves the record to the stop path when the PID was reused', async () => {
  // 공용 경로가 기록을 이미 버렸다. 여기서 한 번 더 지우면 그 사이에 쓰인 교체 러너의 기록을 지울 수 있다.
  const { events, error } = await runWindowsStop({ status: 'stale-record', pid: 4321 });

  assert.equal(error, null);
  assert.deepEqual(events, ['stop:4321']);
});

test('runStopCommand on Windows fails and keeps the record when the runner could not be stopped', async () => {
  const { events, error } = await runWindowsStop(new Error('Timed out waiting for AgentRunner process 4321 to stop.'));

  // 살아 있는 러너를 "멈췄다"고 보고하지 않는다: 예외가 올라가 명령이 0이 아닌 코드로 끝나고 기록이 남는다.
  assert.match(String(error), /Timed out waiting/);
  assert.deepEqual(events, ['stop:4321']);
});

test('runStopCommand reports a runner that is not running without stopping anything', async () => {
  const messages: string[] = [];
  await runStopCommand({
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: false, pid: null, instanceId: null, ready: false }),
    stopWindowsDaemonInstance: async () => assert.fail('nothing to stop'),
    removePidFile: async () => assert.fail('nothing to remove'),
    logger: { ...silentLogger, info: (message) => messages.push(message) },
  });

  assert.deepEqual(messages, ['Daemon is not running']);
});
