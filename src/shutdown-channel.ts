import { createConnection, createServer, type Server, type Socket } from 'node:net';

// Windows에는 다른 프로세스의 종료 핸들러를 실행시키는 신호가 없다. `process.kill(pid, 'SIGTERM')`은
// TerminateProcess라서 러너가 실행 중인 엔진을 정리하거나 CANCELLED를 보고할 기회 없이 죽는다
// (2026-11-21 실측: 러너만 사라지고 엔진은 살아 있었으며 상태 보고가 0건이었다).
// 그래서 러너가 인스턴스 전용 named pipe로 종료 요청을 받아 POSIX의 SIGTERM과 같은 정상 종료 루틴을 실행한다.
//
// 경계:
// - pipe 이름에 PID와 instanceId가 들어가므로 요청은 그 인스턴스에만 닿는다. 교체된 러너는 다른 이름을 연다.
// - 요청에는 PID 기록에 적힌 controlToken이 있어야 한다. PID 기록은 사용자 프로필 안에 있으므로 그 파일을
//   읽을 수 있는 주체만 종료를 요청할 수 있다. pipe 이름은 다른 사용자도 열거할 수 있으므로 경계는 토큰이다.

export type ShutdownChannelTarget = {
  pid: number;
  instanceId: string;
  controlToken: string;
};

/** 종료 요청이 러너에 어떻게 닿았는지. `accepted`만 "러너가 정상 종료를 시작했다"는 뜻이다. */
export type ShutdownRequestOutcome = 'accepted' | 'rejected' | 'unavailable' | 'timeout';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 4_096;

export const getShutdownPipePath = (target: Pick<ShutdownChannelTarget, 'pid' | 'instanceId'>): string =>
  `\\\\.\\pipe\\agentteams-runner-${target.pid}-${target.instanceId}`;

type ShutdownRequest = { type: 'shutdown'; token: string };

const parseRequest = (line: string): ShutdownRequest | null => {
  try {
    const parsed = JSON.parse(line) as Partial<ShutdownRequest>;
    return parsed.type === 'shutdown' && typeof parsed.token === 'string'
      ? { type: 'shutdown', token: parsed.token }
      : null;
  } catch {
    return null;
  }
};

export type ShutdownListener = {
  close: () => Promise<void>;
};

type ListenDeps = {
  createServer?: typeof createServer;
  pipePath?: string;
};

/**
 * 종료 요청 수신을 시작한다. 수신부가 실제로 열린 뒤에 resolve하므로, 호출자는 그 다음에 PID 기록을 써서
 * "기록은 있는데 수신부는 아직 없는" 틈을 만들지 않을 수 있다.
 *
 * `onShutdown`은 승인 응답을 보낸 뒤 호출된다. 같은 요청이 여러 번 와도 매번 승인하고 매번 호출하므로
 * `onShutdown`은 멱등이어야 한다(러너의 종료 루틴은 이미 멱등이다).
 */
export const listenForShutdownRequests = (
  target: ShutdownChannelTarget,
  onShutdown: () => void,
  deps: ListenDeps = {},
): Promise<ShutdownListener> =>
  new Promise((resolve, reject) => {
    const handleConnection = (socket: Socket): void => {
      let buffer = '';
      let answered = false;
      let authorized = false;
      let shutdownInvoked = false;
      const invokeShutdown = (): void => {
        if (shutdownInvoked) return;
        shutdownInvoked = true;
        onShutdown();
      };
      const answer = (payload: { ok: boolean; reason?: string }, afterWrite?: () => void): void => {
        if (answered) return;
        answered = true;
        socket.end(`${JSON.stringify(payload)}\n`, afterWrite);
      };

      socket.setEncoding('utf8');
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
      socket.on('error', () => undefined);
      // 요청자가 응답을 읽기 전에 끊어도 승인된 요청은 실행한다. 그러지 않으면 요청자는 강제 종료로 넘어간다.
      socket.on('close', () => {
        if (authorized) invokeShutdown();
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.destroy();
          return;
        }
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) return;

        const request = parseRequest(buffer.slice(0, newlineIndex));
        if (!request) {
          answer({ ok: false, reason: 'invalid-request' });
          return;
        }
        if (request.token !== target.controlToken) {
          answer({ ok: false, reason: 'unauthorized' });
          return;
        }
        // 응답을 먼저 내보낸다. 종료 루틴이 곧바로 프로세스를 끝내면 요청자가 승인을 받지 못한 채 연결이 끊긴다.
        authorized = true;
        answer({ ok: true }, invokeShutdown);
      });
    };

    const server: Server = (deps.createServer ?? createServer)(handleConnection);
    server.once('error', reject);
    server.listen(deps.pipePath ?? getShutdownPipePath(target), () => {
      server.removeListener('error', reject);
      server.on('error', () => undefined);
      // 수신부가 러너의 종료를 붙잡지 않게 한다.
      server.unref();
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });

type RequestDeps = {
  createConnection?: typeof createConnection;
  pipePath?: string;
  timeoutMs?: number;
};

/**
 * 러너에 정상 종료를 요청한다. 러너가 요청을 받아들였는지만 답하며, 실제로 끝났는지는 호출자가 PID로 확인한다.
 *
 * - `unavailable`: 수신부가 없다(종료 요청을 지원하지 않는 구버전 러너, 이미 끝난 러너).
 * - `rejected`: 수신부가 토큰을 거부했다(기록과 수신부가 서로 다른 인스턴스).
 * - `timeout`: 연결은 됐지만 제한 시간 안에 답이 없다.
 */
export const requestShutdown = (
  target: ShutdownChannelTarget,
  deps: RequestDeps = {},
): Promise<ShutdownRequestOutcome> =>
  new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = (deps.createConnection ?? createConnection)(deps.pipePath ?? getShutdownPipePath(target));
    const settle = (outcome: ShutdownRequestOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('timeout'), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'shutdown', token: target.controlToken })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex)) as { ok?: boolean };
        settle(response.ok === true ? 'accepted' : 'rejected');
      } catch {
        settle('rejected');
      }
    });
    // 연결 자체가 안 되면 수신부가 없는 것이다. 연결된 뒤 답 없이 끊기면 요청이 받아들여졌는지 알 수 없다.
    socket.on('error', () => settle('unavailable'));
    socket.on('close', () => settle('unavailable'));
  });
