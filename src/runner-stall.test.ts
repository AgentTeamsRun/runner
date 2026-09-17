import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DaemonApiClient } from './api-client.js';
import {
  buildWindowsPowerShellWrapper,
  refreshWindowsPowerShellWrapper,
  migrateWindowsAutostartOnBoot,
} from './autostart.js';

for (const warning of [false, true]) {
  for (const exitCode of [0, 7]) {
    test(
      `Windows wrapper preserves exit ${exitCode}, warning=${warning}`,
      { skip: process.platform !== 'win32' },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), 'runner stall '));
        try {
          const fixture = join(directory, 'fixture.cjs');
          const command = join(directory, 'runner.cmd');
          const wrapper = join(directory, 'start.ps1');
          const log = join(directory, 'runner.log');
          await writeFile(
            fixture,
            `${warning ? 'console.error("benign warning");' : ''} setTimeout(() => { console.log("survived 한글"); process.exit(${exitCode}); }, 100);`,
          );
          await writeFile(command, `@echo off\r\n"${process.execPath}" "${fixture}"\r\nexit /b %errorlevel%\r\n`);
          await writeFile(
            wrapper,
            '\uFEFF' +
              buildWindowsPowerShellWrapper({ token: 'fixture', apiUrl: 'https://example.invalid' }, command, log),
          );
          const result = spawnSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
            { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
          );
          assert.equal(result.error, undefined);
          assert.equal(result.status, exitCode, result.stderr);
          const output = await readFile(log);
          const content = output.toString(output[0] === 0xff ? 'utf16le' : 'utf8');
          assert.match(content, /survived/u);
          assert.match(content, /한글/u);
          if (warning) assert.match(content, /benign warning/u);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
}

test('native installs refresh only the legacy wrapper, atomically and idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrapper-migration-'));
  const wrapper = join(directory, 'start.ps1');
  const original =
    "$env:PATH = 'keep-me'\r\n$logPath = 'fixture.log'\r\n& 'C:\\old path\\runner.cmd' start *>> 'fixture.log'\r\nexit $LASTEXITCODE";
  try {
    await writeFile(wrapper, original);
    await assert.rejects(
      refreshWindowsPowerShellWrapper(wrapper, () => {
        throw new Error('ACL failed');
      }),
      /ACL failed/u,
    );
    assert.equal(await readFile(wrapper, 'utf8'), original);
    let secured = 0;
    const refresh = () =>
      refreshWindowsPowerShellWrapper(wrapper, () => {
        secured += 1;
      });
    for (let i = 0; i < 2; i += 1) {
      await migrateWindowsAutostartOnBoot({
        platform: () => 'win32',
        getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
        windowsTaskNeedsNativeLauncherMigration: () => false,
        refreshWindowsPowerShellWrapper: refresh,
        registerWindowsTask: async () => {
          throw new Error('must not register or start');
        },
        logger: { info: () => undefined, warn: () => assert.fail('unexpected warning') },
      });
    }
    const updated = await readFile(wrapper, 'utf8');
    assert.match(updated, /keep-me/u);
    assert.match(updated, /Get-Command 'C:\\old path\\runner.cmd'/u);
    assert.match(updated, /runner-wrapper-version: 2/u);
    assert.equal(secured, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'Windows wrapper still fails for a missing executable or unwritable log',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runner-errors-'));
    try {
      const command = join(directory, 'runner.cmd');
      await writeFile(command, '@echo off\r\necho fixture\r\nexit /b 0\r\n');
      for (const missingExecutable of [true, false]) {
        const wrapper = join(directory, 'start.ps1');
        await writeFile(
          wrapper,
          buildWindowsPowerShellWrapper(
            { token: 'fixture', apiUrl: 'https://example.invalid' },
            missingExecutable ? join(directory, 'absent.cmd') : command,
            missingExecutable ? join(directory, 'runner.log') : directory,
          ),
        );
        const result = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
          { windowsHide: true, timeout: 10_000 },
        );
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('API deadline covers an unfinished response body and recovers', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, delay, ...args) =>
    originalSetTimeout(
      callback,
      delay === 30_000 ? 50 : [1000, 2000, 4000].includes(delay as number) ? 1 : delay,
      ...args,
    )) as typeof setTimeout;
  let stalled = true;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (stalled) response.write('{"data":');
    else response.end('{"data":{"pendingTrigger":null}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new DaemonApiClient(`http://127.0.0.1:${address.port}`, 'fixture');
  let guard: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      client.fetchPollState().then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => {
        guard = originalSetTimeout(() => resolve('still pending'), 2000);
      }),
    ]);
    assert.equal(result, 'rejected');
    stalled = false;
    assert.equal((await client.fetchPollState()).data.pendingTrigger, null);
  } finally {
    clearTimeout(guard);
    globalThis.setTimeout = originalSetTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('status-only responses cancel unfinished bodies without replaying mutations', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 30_000 ? 100 : delay, ...args)) as typeof setTimeout;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(requests === 1 ? 200 : 409, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new DaemonApiClient(`http://127.0.0.1:${address.port}`, 'fixture');
  try {
    assert.deepEqual(await client.claimTrigger('fixture'), { ok: true, conflict: false });
    assert.deepEqual(await client.claimTrigger('fixture'), { ok: false, conflict: true });
    await assert.rejects(client.fetchPollState(), /409/u);
    assert.equal(requests, 3);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('status-only responses drain delayed bodies and reuse connections', { timeout: 5000 }, async () => {
  let requests = 0;
  let connections = 0;
  let completedBodies = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(request.method === 'GET' ? 503 : requests % 2 === 0 ? 409 : 200);
    response.flushHeaders();
    response.on('finish', () => {
      completedBodies += 1;
    });
    setTimeout(() => response.end('{}'), 20);
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new DaemonApiClient(`http://127.0.0.1:${address.port}`, 'fixture');
  try {
    for (let index = 0; index < 6; index += 1) {
      assert.deepEqual(await client.claimTrigger('fixture'), {
        ok: index % 2 === 0,
        conflict: index % 2 !== 0,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    await assert.rejects(client.fetchPollState(), /503/u);
    assert.equal(requests, 7);
    assert.equal(completedBodies, 7);
    assert.ok(connections <= 2, `expected connection reuse, opened ${connections} connections`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('invalid JSON is not retried', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end('invalid json');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(
      new DaemonApiClient(`http://127.0.0.1:${address.port}`, 'fixture').fetchPollState(),
      SyntaxError,
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('interrupted read body retries and releases the failed connection', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (requests === 1) {
      response.write('{');
      setTimeout(() => response.destroy(), 20);
    } else {
      response.end('{"data":{"pendingTrigger":null}}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const result = await new DaemonApiClient(`http://127.0.0.1:${address.port}`, 'fixture').fetchPollState();
    assert.equal(result.data.pendingTrigger, null);
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
