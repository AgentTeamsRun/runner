import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeConfig } from '../types.js';
import { runStartCommand } from './start.js';

const runtimeConfig: RuntimeConfig = {
  daemonToken: 'daemon-token',
  apiUrl: 'https://api.example',
  pollingIntervalMs: 30_000,
  maxPollingIntervalMs: 120_000,
  timeoutMs: 86_400_000,
  idleTimeoutMs: 600_000,
  runnerCmd: 'codex',
  preventSleepWhileBusy: true,
};

const runObservedStart = async (): Promise<{
  migrations: number;
  pollingStarts: number;
  order: string[];
}> => {
  let migrations = 0;
  let pollingStarts = 0;
  const order: string[] = [];

  await runStartCommand({
    // 종료 채널은 Windows 전용이다. 이 헬퍼는 기동 순서만 보므로 실제 pipe를 열지 않게 한다.
    platform: () => 'linux',
    refreshExecutablePath: () => undefined,
    ensureCodexSandboxDefault: () => undefined,
    activatePreparedRestartHandoff: async () => false,
    writePidFile: async () => {
      order.push('pid-written');
    },
    removePidFile: async () => undefined,
    markDaemonReady: async () => {
      order.push('ready-marked');
    },
    migrateWindowsAutostartOnBoot: async () => {
      migrations += 1;
      order.push('autostart-migrated');
    },
    processOn: () => undefined,
    resolveRuntimeConfig: async () => runtimeConfig,
    startPolling: async () => {
      pollingStarts += 1;
      order.push('polling-started');
    },
    logger: { info: () => undefined, warn: () => undefined },
  });

  return { migrations, pollingStarts, order };
};

test('runStartCommand preserves polling startup while checking the Windows autostart action', async () => {
  const observed = await runObservedStart();

  assert.equal(observed.migrations, 1);
  assert.equal(observed.pollingStarts, 1);
});

test('runStartCommand migrates a legacy Windows autostart action before polling', async () => {
  const observed = await runObservedStart();

  assert.equal(observed.migrations, 1);
  assert.equal(observed.pollingStarts, 1);
});

test('runStartCommand marks the instance ready only after its runtime config resolves', async () => {
  const observed = await runObservedStart();

  // A restart confirms the replacement from this stamp, so it must not appear
  // before the instance can actually do its job.
  assert.deepEqual(observed.order, ['pid-written', 'ready-marked', 'autostart-migrated', 'polling-started']);
});

test('runStartCommand stamps readiness before the Windows autostart re-registration', async () => {
  const observed = await runObservedStart();

  // The migration only changes what the *next* start uses, and its subprocess
  // round trip is slowest under exactly the CPU pressure a restart budgets for.
  // Keeping it out of the readiness window is what stops a healthy start from
  // being reported as [stage: not-ready].
  assert.ok(observed.order.indexOf('ready-marked') < observed.order.indexOf('autostart-migrated'));
});

type WindowsStartObservation = {
  order: string[];
  pidFileArgs: unknown;
  requestShutdown: () => void;
  exitCodes: number[];
  removedInstanceIds: string[];
  pollerShutdowns: number;
};

const runWindowsStart = async (options: { channelFails?: boolean; requestBeforePolling?: boolean } = {}) => {
  const observation: WindowsStartObservation = {
    order: [],
    pidFileArgs: undefined,
    requestShutdown: () => assert.fail('the shutdown channel was never opened'),
    exitCodes: [],
    removedInstanceIds: [],
    pollerShutdowns: 0,
  };
  let exitListener: () => void = () => undefined;

  await runStartCommand({
    platform: () => 'win32',
    processPid: 4321,
    refreshExecutablePath: () => undefined,
    ensureCodexSandboxDefault: () => undefined,
    activatePreparedRestartHandoff: async () => false,
    listenForShutdownRequests: async (target, onShutdown) => {
      observation.order.push(`channel-open:${target.pid}`);
      if (options.channelFails) throw new Error('EACCES');
      observation.requestShutdown = onShutdown;
      return { close: async () => undefined };
    },
    writePidFile: async (args) => {
      observation.order.push('pid-written');
      observation.pidFileArgs = args;
      if (options.requestBeforePolling) observation.requestShutdown();
    },
    removePidFile: async () => undefined,
    removeOwnPidFileSync: (instanceId) => {
      observation.removedInstanceIds.push(instanceId);
    },
    markDaemonReady: async () => undefined,
    migrateWindowsAutostartOnBoot: async () => undefined,
    processOn: (event, listener) => {
      if (event === 'exit') exitListener = listener;
    },
    processExit: (code) => {
      observation.exitCodes.push(code);
    },
    resolveRuntimeConfig: async () => runtimeConfig,
    startPolling: async (_config, _createHandler, dependencies) => {
      observation.order.push('polling-started');
      dependencies?.onShutdownAvailable?.(async () => {
        observation.pollerShutdowns += 1;
      });
    },
    logger: { info: () => undefined, warn: () => undefined },
  });

  return { observation, fireExit: () => exitListener() };
};

test('runStartCommand on Windows opens the shutdown channel before it publishes the PID record', async () => {
  const { observation } = await runWindowsStart();

  // 기록을 읽은 stop이 아직 없는 수신부에 요청하는 틈이 없어야 한다.
  assert.deepEqual(observation.order, ['channel-open:4321', 'pid-written', 'polling-started']);
  const args = observation.pidFileArgs as { instanceId: string; controlToken: string | null };
  assert.equal(typeof args.instanceId, 'string');
  assert.equal(typeof args.controlToken, 'string');
});

test('runStartCommand on Windows routes a channel request into the poller shutdown routine', async () => {
  const { observation } = await runWindowsStart();

  observation.requestShutdown();

  assert.equal(observation.pollerShutdowns, 1);
  assert.deepEqual(observation.exitCodes, [], 'the poller owns the exit once it is running');
});

test('runStartCommand on Windows exits at once when asked to stop before polling has started', async () => {
  const { observation } = await runWindowsStart({ requestBeforePolling: true });

  // 취소할 실행이 아직 없다. 요청을 무시하고 계속 뜨면 stop이 제한 시간까지 기다린 뒤 강제 종료하게 된다.
  assert.deepEqual(observation.exitCodes, [0]);
  assert.equal(observation.pollerShutdowns, 0);
});

test('runStartCommand on Windows publishes no control token when the channel cannot be opened', async () => {
  const { observation } = await runWindowsStart({ channelFails: true });

  // 토큰 없는 기록은 stop이 "채널 없는 러너"로 다루게 한다 — 닿지 않는 채널에 요청하며 기다리지 않는다.
  assert.equal((observation.pidFileArgs as { controlToken: string | null }).controlToken, null);
  assert.deepEqual(observation.order, ['channel-open:4321', 'pid-written', 'polling-started']);
});

test('runStartCommand on Windows removes only its own PID record when the process exits', async () => {
  const { observation, fireExit } = await runWindowsStart();

  fireExit();

  assert.deepEqual(observation.removedInstanceIds, [(observation.pidFileArgs as { instanceId: string }).instanceId]);
});
