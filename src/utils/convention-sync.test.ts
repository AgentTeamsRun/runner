import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runConventionSync } from './convention-sync.js';

type FakeSpawnCall = {
  cmd: string;
  args: string[];
  opts: object;
};

type FakeSpawnResponse = {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

const createFakeSpawn = (responses: FakeSpawnResponse[], calls: FakeSpawnCall[] = []) => {
  return (cmd: string, args: string[], opts: object): ChildProcess => {
    calls.push({ cmd, args, opts });
    const response = responses.shift() ?? { exitCode: 0 };
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr });
    process.nextTick(() => {
      if (response.error) {
        child.emit('error', response.error);
      } else {
        if (response.stdout) stdout.emit('data', response.stdout);
        if (response.stderr) stderr.emit('data', response.stderr);
        child.emit('close', response.exitCode);
      }
    });
    return child;
  };
};

test.afterEach(() => {
  mock.restoreAll();
});

test('runConventionSync skips download when status reports no update', async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const calls: FakeSpawnCall[] = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: object) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  await runConventionSync('/fake/path', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: createFakeSpawn([{ exitCode: 0, stdout: JSON.stringify({ updateAvailable: false }) }], calls) as any,
    logger: fakeLogger,
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [['convention', 'status']],
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, 'info');
  assert.match(logs[0]!.message, /up to date/i);
});

test('runConventionSync downloads when status reports an update', async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const calls: FakeSpawnCall[] = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: object) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  await runConventionSync('/fake/path', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: createFakeSpawn(
      [{ exitCode: 0, stdout: JSON.stringify({ updateAvailable: true }) }, { exitCode: 0 }],
      calls,
    ) as any,
    logger: fakeLogger,
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['convention', 'status'],
      ['convention', 'download'],
    ],
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, 'info');
  assert.match(logs[0]!.message, /completed/i);
});

test('runConventionSync logs warn when status exits non-zero', async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const calls: FakeSpawnCall[] = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: object) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  await runConventionSync('/fake/path', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: createFakeSpawn([{ exitCode: 1, stderr: 'not configured' }], calls) as any,
    logger: fakeLogger,
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [['convention', 'status']],
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, 'warn');
  assert.match(logs[0]!.message, /status.*non-zero/i);
});

test('runConventionSync logs warn when status returns invalid JSON', async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: object) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  await runConventionSync('/fake/path', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: createFakeSpawn([{ exitCode: 0, stdout: 'not-json' }]) as any,
    logger: fakeLogger,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, 'warn');
  assert.match(logs[0]!.message, /invalid JSON/i);
});

test('runConventionSync logs warn when download exits non-zero', async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: object) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  await runConventionSync('/fake/path', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: createFakeSpawn([
      { exitCode: 0, stdout: JSON.stringify({ updateAvailable: true }) },
      { exitCode: 1, stderr: 'download failed' },
    ]) as any,
    logger: fakeLogger,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, 'warn');
  assert.match(logs[0]!.message, /non-zero/i);
});

test('runConventionSync logs warn on spawn error', async () => {
  const logs: Array<{ level: string; message: string; meta?: object }> = [];
  const fakeLogger = {
    info: (message: string, meta?: object) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: object) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  await runConventionSync('/fake/path', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: createFakeSpawn([{ exitCode: null, error: new Error('ENOENT') }]) as any,
    logger: fakeLogger,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, 'warn');
  assert.match(logs[0]!.message, /spawn error/i);
});

test('runConventionSync never throws', async () => {
  const fakeLogger = {
    info: () => {},
    warn: () => {},
  };

  const throwingSpawn = () => {
    throw new Error('unexpected');
  };

  await assert.doesNotReject(
    runConventionSync('/fake/path', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: throwingSpawn as any,
      logger: fakeLogger,
    }),
  );
});
