import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startPolling } from './poller.js';
import type { DaemonTrigger, RuntimeConfig } from './types.js';

const config: RuntimeConfig = {
  daemonToken: 'test',
  apiUrl: 'http://unused.invalid',
  pollingIntervalMs: 1000,
  maxPollingIntervalMs: 1000,
  timeoutMs: 60_000,
  idleTimeoutMs: 60_000,
  runnerCmd: 'opencode',
  preventSleepWhileBusy: false,
};
const trigger = { id: 'shutdown-test' } as DaemonTrigger;
const state = { data: { orphanedCancelRequestedTriggerIds: [], pendingWorktreeRemovals: [], pendingTrigger: trigger } };

test('shutdown aborts active handlers and waits for their cleanup before exiting', async () => {
  const events: string[] = [];
  const signals = new Map<string, () => void>();
  let release!: () => void;
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const polling = startPolling(
    config,
    () => async (_trigger, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => events.push('abort'), { once: true });
      started();
      await cleanup;
      events.push('cleaned');
    },
    {
      createClient: () =>
        ({ fetchPollState: async () => state, claimTrigger: async () => ({ ok: true, conflict: false }) }) as never,
      loadAuthPaths: () => [],
      now: () => 0,
      setTimeout: (() => ({})) as never,
      clearTimeout: () => {},
      powerSaveBlocker: { acquire: () => () => {} },
      processOn: (name, callback) => {
        signals.set(name, callback);
      },
      processExit: (() => {
        events.push('exit');
      }) as never,
      keepAlive: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    },
  );
  await running;
  await delay(0);
  signals.get('SIGTERM')!();
  assert.deepEqual(events, ['abort']);
  release();
  await delay(10);
  assert.deepEqual(events, ['abort', 'cleaned', 'exit']);
  finish();
  await polling;
});

test('shutdown exits once within its deadline even when a handler ignores cancellation', async () => {
  const signals = new Map<string, () => void>();
  let started!: () => void;
  let finish!: () => void;
  let exited!: () => void;
  let aborted = false;
  let exits = 0;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const polling = startPolling(
    config,
    () => async (_trigger, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      started();
      await new Promise<void>(() => {});
    },
    {
      createClient: () =>
        ({ fetchPollState: async () => state, claimTrigger: async () => ({ ok: true, conflict: false }) }) as never,
      loadAuthPaths: () => [],
      now: () => 0,
      shutdownTimeoutMs: 15,
      setTimeout: (() => ({})) as never,
      clearTimeout: () => {},
      powerSaveBlocker: { acquire: () => () => {} },
      processOn: (name, callback) => {
        signals.set(name, callback);
      },
      processExit: (() => {
        exits++;
        exited();
      }) as never,
      keepAlive: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    },
  );
  await running;
  await delay(0);
  signals.get('SIGTERM')!();
  signals.get('SIGINT')!();
  await exit;
  assert.equal(aborted, true);
  assert.equal(exits, 1);
  finish();
  await polling;
});

test(
  'SIGTERM stops the actual detached engine process group before the daemon exits',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daemon-shutdown-'));
    const engine = join(directory, 'engine');
    const pidPath = join(directory, 'engine.pid');
    const script = join(directory, 'daemon.mts');
    let enginePid: number | undefined;
    await writeFile(
      engine,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);\n`,
    );
    await chmod(engine, 0o755);
    const pollerPath = fileURLToPath(new URL('./poller.ts', import.meta.url));
    const runnerPath = fileURLToPath(new URL('./runners/opencode.ts', import.meta.url));
    await writeFile(
      script,
      `import {startPolling} from ${JSON.stringify(pollerPath)};
import {OpenCodeRunner} from ${JSON.stringify(runnerPath)};
const config=${JSON.stringify(config)};
const opts=${JSON.stringify({ triggerId: 'shutdown', prompt: 'test', authPath: directory, apiKey: 'test', apiUrl: config.apiUrl, teamId: 'team', projectId: 'project', agentConfigId: 'agent', runnerType: 'OPENCODE', timeoutMs: 60000, idleTimeoutMs: 60000 })};
await startPolling(config,()=>async(_trigger,signal)=>{await new OpenCodeRunner(${JSON.stringify(engine)}).run({...opts,signal});},{
createClient:()=>({fetchPollState:async()=>(${JSON.stringify(state)}),claimTrigger:async()=>({ok:true,conflict:false})}),loadAuthPaths:()=>[],now:()=>0,powerSaveBlocker:{acquire:()=>()=>{}}});`,
    );
    const daemon = spawn(
      process.execPath,
      ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), script],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true },
    );
    let diagnostics = '';
    daemon.stdout.on('data', (chunk) => {
      diagnostics += String(chunk);
    });
    daemon.stderr.on('data', (chunk) => {
      diagnostics += String(chunk);
    });
    const closed = once(daemon, 'exit');
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          enginePid = Number(await readFile(pidPath, 'utf8'));
          break;
        } catch {
          await delay(20);
        }
      }
      assert.ok(enginePid, diagnostics);
      daemon.kill('SIGTERM');
      await closed;
      assert.throws(() => process.kill(-enginePid!, 0), { code: 'ESRCH' });
    } finally {
      for (const pid of [enginePid, daemon.pid]) {
        if (pid) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {}
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
