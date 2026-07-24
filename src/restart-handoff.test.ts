import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgePreparedRestartHandoff,
  activatePreparedRestartHandoff,
  buildRestartHandoffEnv,
  isCurrentPreparedHandoff,
  restartHandoffIdEnv,
  restartHandoffParentPidEnv,
  restartHandoffPathEnv,
  waitForPreparedRestartHandoff,
  type RestartHandoffPreparation,
} from './restart-handoff.js';

test('isCurrentPreparedHandoff accepts only the prepared signal for the active handoff', () => {
  const prepared: RestartHandoffPreparation = {
    status: 'prepared',
    handoffId: 'current-handoff',
    markerPath: '/tmp/restart-handoff-current.json',
    replacementPid: 9002,
    replacementReady: true,
    acknowledged: false,
    retryableFailure: false,
  };

  assert.equal(isCurrentPreparedHandoff(prepared, 'current-handoff'), true);
  assert.equal(isCurrentPreparedHandoff(prepared, 'stale-handoff'), false);
});

test('isCurrentPreparedHandoff rejects retryable failures even when the correlation id matches', () => {
  const failed: RestartHandoffPreparation = {
    status: 'retryable-failure',
    handoffId: 'current-handoff',
    replacementReady: false,
    acknowledged: false,
    retryableFailure: true,
    reason: 'helper-preparation-failed',
    error: 'schtasks /Query failed with exit 1',
  };

  assert.equal(isCurrentPreparedHandoff(failed, 'current-handoff'), false);
});

test('buildRestartHandoffEnv passes only correlation metadata needed by the standby runner', () => {
  const env = buildRestartHandoffEnv(
    {
      handoffId: 'manual-handoff',
      parentPid: 4321,
      markerPath: '/tmp/restart-handoff.json',
    },
    { EXISTING_VALUE: 'preserved' },
  );

  assert.equal(env.EXISTING_VALUE, 'preserved');
  assert.equal(env[restartHandoffIdEnv], 'manual-handoff');
  assert.equal(env[restartHandoffParentPidEnv], '4321');
  assert.equal(env[restartHandoffPathEnv], '/tmp/restart-handoff.json');
});

test('waitForPreparedRestartHandoff rejects stale and parent-owned markers before accepting the replacement', async () => {
  const markers = [
    { handoffId: 'stale', replacementPid: 9001, state: 'prepared' },
    { handoffId: 'current', replacementPid: 4321, state: 'prepared' },
    { handoffId: 'current', replacementPid: 9002, state: 'prepared' },
  ];

  const result = await waitForPreparedRestartHandoff(
    {
      handoffId: 'current',
      parentPid: 4321,
      markerPath: '/tmp/restart-handoff.json',
    },
    {
      readFile: async () => JSON.stringify(markers.shift()),
      sleep: async () => undefined,
      now: () => 0,
      isProcessRunning: (pid) => pid === 4321 || pid === 9002,
    },
  );

  assert.equal(result.status, 'prepared');
  assert.equal(result.handoffId, 'current');
  if (result.status === 'prepared') {
    assert.equal(result.markerPath, '/tmp/restart-handoff.json');
    assert.equal(result.replacementPid, 9002);
  }
});

test('acknowledgePreparedRestartHandoff commits only the live correlated standby', async () => {
  const writes: string[] = [];
  let markerContent = JSON.stringify({
    handoffId: 'current-handoff',
    replacementPid: 9002,
    state: 'prepared',
  });
  const acknowledged = await acknowledgePreparedRestartHandoff(
    {
      status: 'prepared',
      handoffId: 'current-handoff',
      markerPath: '/tmp/restart-handoff-current.json',
      replacementPid: 9002,
      replacementReady: true,
      acknowledged: false,
      retryableFailure: false,
    },
    {
      readFile: async () => markerContent,
      writeFile: async (_path, data) => {
        writes.push(data);
        markerContent = data;
      },
      chmodSync: () => undefined,
      isProcessRunning: (pid) => pid === 9002,
    },
  );

  assert.equal(acknowledged, true);
  assert.match(writes[0] ?? '', /"state":"acknowledged"/u);
});

test('acknowledgePreparedRestartHandoff rejects a dead or superseded standby', async () => {
  const prepared = {
    status: 'prepared' as const,
    handoffId: 'current-handoff',
    markerPath: '/tmp/restart-handoff-current.json',
    replacementPid: 9002,
    replacementReady: true as const,
    acknowledged: false as const,
    retryableFailure: false as const,
  };

  assert.equal(
    await acknowledgePreparedRestartHandoff(prepared, {
      readFile: async () =>
        JSON.stringify({
          handoffId: 'newer-handoff',
          replacementPid: 9003,
          state: 'prepared',
        }),
      writeFile: async () => {
        throw new Error('must not overwrite a newer handoff');
      },
      isProcessRunning: () => true,
    }),
    false,
  );
  assert.equal(
    await acknowledgePreparedRestartHandoff(prepared, {
      readFile: async () =>
        JSON.stringify({
          handoffId: 'current-handoff',
          replacementPid: 9002,
          state: 'prepared',
        }),
      writeFile: async () => {
        throw new Error('must not acknowledge a dead standby');
      },
      isProcessRunning: () => false,
    }),
    false,
  );
});

test('activatePreparedRestartHandoff waits for acknowledgement and does not lose activation to PID reuse', async () => {
  const events: string[] = [];
  let markerReads = 0;
  let clock = 0;

  const activated = await activatePreparedRestartHandoff({
    env: {
      [restartHandoffIdEnv]: 'manual-handoff',
      [restartHandoffParentPidEnv]: '4321',
      [restartHandoffPathEnv]: '/tmp/restart-handoff.json',
    },
    processPid: 9002,
    mkdir: async () => {
      events.push('mkdir');
    },
    writeFile: async (_path, data) => {
      events.push(`write:${data}`);
    },
    chmodSync: () => {
      events.push('chmod');
    },
    readFile: async () => {
      markerReads += 1;
      return JSON.stringify({
        handoffId: 'manual-handoff',
        replacementPid: 9002,
        state: markerReads < 2 ? 'prepared' : 'acknowledged',
      });
    },
    unlink: async () => {
      events.push('unlink');
    },
    sleep: async () => {
      events.push('sleep');
    },
    now: () => {
      const value = clock;
      clock += 3_000;
      return value;
    },
    isProcessRunning: () => true,
  });

  assert.equal(activated, true);
  assert.match(events[1] ?? '', /"handoffId":"manual-handoff"/u);
  assert.match(events[1] ?? '', /"replacementPid":9002/u);
  assert.ok(events.includes('unlink'));
  assert.equal(markerReads, 3);
});

test('activatePreparedRestartHandoff does not remove a superseding handoff marker', async () => {
  let removed = false;

  await assert.rejects(
    activatePreparedRestartHandoff({
      env: {
        [restartHandoffIdEnv]: 'manual-old',
        [restartHandoffParentPidEnv]: '4321',
        [restartHandoffPathEnv]: '/tmp/restart-handoff-old.json',
      },
      processPid: 9002,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      chmodSync: () => undefined,
      readFile: async () =>
        JSON.stringify({
          handoffId: 'manual-new',
          replacementPid: 9003,
          state: 'acknowledged',
        }),
      unlink: async () => {
        removed = true;
      },
      sleep: async () => undefined,
      now: () => 0,
      isProcessRunning: () => false,
    }),
    /superseded/u,
  );

  assert.equal(removed, false);
});

test('activatePreparedRestartHandoff removes its owned marker and fails when acknowledgement never arrives', async () => {
  let clock = 0;
  let removed = false;

  await assert.rejects(
    activatePreparedRestartHandoff({
      env: {
        [restartHandoffIdEnv]: 'manual-timeout',
        [restartHandoffParentPidEnv]: '4321',
        [restartHandoffPathEnv]: '/tmp/restart-handoff.json',
      },
      processPid: 9002,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      chmodSync: () => undefined,
      readFile: async () =>
        JSON.stringify({
          handoffId: 'manual-timeout',
          replacementPid: 9002,
          state: 'prepared',
        }),
      unlink: async () => {
        removed = true;
      },
      sleep: async () => undefined,
      now: () => {
        const value = clock;
        clock += 6;
        return value;
      },
      timeoutMs: 5,
      isProcessRunning: () => true,
    }),
    /timed out waiting for acknowledgement/u,
  );

  assert.equal(removed, true);
});
