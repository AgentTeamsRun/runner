import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getShutdownPipePath,
  listenForShutdownRequests,
  requestShutdown,
  type ShutdownChannelTarget,
} from './shutdown-channel.js';

// 수신부는 승인 응답을 내보낸 뒤 종료 루틴을 부르므로, 요청자가 승인을 받은 직후에는 아직 호출 전일 수 있다.
const eventually = async (description: string, probe: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!probe()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// 채널 자체는 node:net IPC라 플랫폼과 무관하게 검증한다. Windows에서는 실제 named pipe 경로를,
// 그 밖에서는 임시 unix socket을 쓴다.
const withChannel = async (
  body: (context: { target: ShutdownChannelTarget; pipePath: string; shutdowns: () => number }) => Promise<void>,
): Promise<void> => {
  const target: ShutdownChannelTarget = { pid: process.pid, instanceId: randomUUID(), controlToken: randomUUID() };
  const directory = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'shutdown-channel-'));
  const pipePath = directory ? join(directory, 'channel.sock') : getShutdownPipePath(target);
  let shutdowns = 0;
  const listener = await listenForShutdownRequests(target, () => (shutdowns += 1), { pipePath });
  try {
    await body({ target, pipePath, shutdowns: () => shutdowns });
  } finally {
    await listener.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
};

test('the pipe name is scoped to one runner instance', () => {
  const a = getShutdownPipePath({ pid: 100, instanceId: 'instance-a' });
  assert.equal(a, '\\\\.\\pipe\\agentteams-runner-100-instance-a');
  assert.notEqual(a, getShutdownPipePath({ pid: 100, instanceId: 'instance-b' }));
  assert.notEqual(a, getShutdownPipePath({ pid: 101, instanceId: 'instance-a' }));
});

test('a request carrying the instance token is accepted and runs the shutdown routine', async () => {
  await withChannel(async ({ target, pipePath, shutdowns }) => {
    assert.equal(await requestShutdown(target, { pipePath }), 'accepted');
    await eventually('the shutdown routine to run', () => shutdowns() === 1);
  });
});

test('duplicate requests are all accepted so a repeated stop never reads as a failure', async () => {
  await withChannel(async ({ target, pipePath, shutdowns }) => {
    const outcomes = await Promise.all([requestShutdown(target, { pipePath }), requestShutdown(target, { pipePath })]);
    assert.deepEqual(outcomes, ['accepted', 'accepted']);
    assert.equal(await requestShutdown(target, { pipePath }), 'accepted');
    // 종료 루틴이 멱등이므로 매번 호출해도 된다(poller의 shutdown은 같은 promise를 돌려준다).
    await eventually('every accepted request to reach the shutdown routine', () => shutdowns() === 3);
  });
});

test('a request with the wrong token is rejected and does not shut the runner down', async () => {
  await withChannel(async ({ target, pipePath, shutdowns }) => {
    assert.equal(await requestShutdown({ ...target, controlToken: 'someone-else' }, { pipePath }), 'rejected');
    assert.equal(shutdowns(), 0);
  });
});

test('a malformed request is rejected and does not shut the runner down', async () => {
  await withChannel(async ({ pipePath, shutdowns }) => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(pipePath);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write('shut down please\n'));
      socket.on('data', (chunk: string) => (buffer += chunk));
      socket.on('close', () => resolve(buffer));
      socket.on('error', reject);
    });

    assert.deepEqual(JSON.parse(response), { ok: false, reason: 'invalid-request' });
    assert.equal(shutdowns(), 0);
  });
});

test('a runner without a listening channel is reported as unavailable, not as stopped', async () => {
  const target: ShutdownChannelTarget = { pid: process.pid, instanceId: randomUUID(), controlToken: 'token' };
  const pipePath =
    process.platform === 'win32' ? getShutdownPipePath(target) : join(tmpdir(), `absent-${target.instanceId}.sock`);

  assert.equal(await requestShutdown(target, { pipePath }), 'unavailable');
});

test('a channel that never answers is reported as a timeout', async () => {
  await withChannel(async ({ target, pipePath, shutdowns }) => {
    // 연결만 하고 요청을 보내지 않는 대신, 응답을 주지 않는 상대를 흉내 내려면 요청 측 제한 시간을 0에 가깝게 둔다.
    const outcome = await requestShutdown(target, {
      pipePath,
      timeoutMs: 1,
      createConnection: ((path: string) => {
        const socket = createConnection(path);
        // 요청을 쓰지 못하게 해 수신부가 답할 것이 없게 만든다.
        socket.write = (() => true) as typeof socket.write;
        return socket;
      }) as typeof createConnection,
    });

    assert.equal(outcome, 'timeout');
    assert.equal(shutdowns(), 0);
  });
});
