import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { executeModelEnumerationCommand } from './model-enumerator.js';

test(
  'enumeration timeout rejects before close and kills descendants holding inherited pipes',
  { skip: process.platform === 'win32' },
  async () => {
    let parent: ChildProcess | undefined;
    let grandchild = 0;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = executeModelEnumerationCommand(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});console.log(c.pid);setInterval(()=>{},1000);`,
      ],
      {
        timeoutMs: 300,
        spawn: ((file: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
          const spawned = spawn(file, args, { ...options, detached: true });
          parent = spawned;
          spawned.stdout!.once('data', (chunk) => {
            grandchild = Number(String(chunk).trim());
            ready();
          });
          return spawned;
        }) as typeof spawn,
      },
    ).then(
      () => null,
      (error: Error) => error,
    );
    try {
      await started;
      const error = await Promise.race([pending, delay(600).then(() => null)]);
      assert.ok(error, 'timeout must not depend on close');
      assert.match(error.message, /timed out/);
      const deadline = Date.now() + 1000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(grandchild, 0);
          await delay(10);
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, 'grandchild must be terminated too');
    } finally {
      if (parent?.pid) {
        try {
          process.kill(-parent.pid, 'SIGKILL');
        } catch {}
      }
      parent?.stdout?.destroy();
      parent?.stderr?.destroy();
      await pending;
    }
  },
);

test('Windows buffer overflow kills the tree and settles even if close is never emitted', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
    stderr,
    kill: () => true,
  }) as unknown as ChildProcess;
  const calls: unknown[][] = [];
  const pending = executeModelEnumerationCommand('C:\\fake.cmd', [], {
    platform: () => 'win32',
    maxBufferBytes: 1,
    spawn: (() => child) as typeof spawn,
    execFileSync: ((...args: unknown[]) => {
      calls.push(args);
      return '';
    }) as never,
  });
  stdout.emit('data', Buffer.from('too much'));
  await assert.rejects(pending, /maxBuffer/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(0, 2), ['taskkill', ['/F', '/T', '/PID', '4242']]);
  assert.equal(stdout.destroyed, true);
  assert.equal(stderr.destroyed, true);
});
