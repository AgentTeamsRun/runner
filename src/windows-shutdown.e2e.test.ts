import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 실제 프로세스로 Windows 종료·재시작을 검증한다. 러너(데몬)와 `stop`은 소스에서 그대로 띄우고,
// API·엔진·사용자 프로필만 격리한 대역을 쓴다.
//
// 격리 원칙(이 테스트는 사용자의 실제 러너가 돌고 있는 장비에서도 실행된다):
// - USERPROFILE을 임시 폴더로 돌려 PID 기록·설정·로그가 실제 `~/.agentteams`에 닿지 않게 한다.
// - 작업 스케줄러의 `AgentRunner` 작업은 이름이 고정이라 격리할 수 없다. 그래서 그 작업을 조회·수정하는
//   경로(기동 시 자동시작 마이그레이션, 재시작의 자동시작 판정)는 하네스가 "등록 안 됨"으로 고정한다.
//   작업 스케줄러에 등록된 상태의 재시작은 GitHub 호스티드 러너의 verify-lifecycle.ps1이 맡는다.
// - 정리는 이 테스트가 띄운 PID로 확인된 프로세스만 대상으로 한다.

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const daemonRoot = dirname(sourceRoot);
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const sourceUrl = (relativePath: string): string => pathToFileURL(join(sourceRoot, relativePath)).href;

const SHUTDOWN_MESSAGE = 'Runner stopped because AgentRunner shut down or restarted';

type StatusReport = { triggerId: string; status: string; errorMessage?: string };

type FakeApi = {
  url: string;
  statusReports: StatusReport[];
  pollCount: () => number;
  offerTrigger: (triggerId: string) => void;
  close: () => Promise<void>;
};

const startFakeApi = async (workDir: string): Promise<FakeApi> => {
  const statusReports: StatusReport[] = [];
  let pendingTriggerId: string | null = null;
  let polls = 0;
  const now = new Date().toISOString();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (payload: unknown): void => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      };
      const triggerMatch = /^\/api\/daemon-triggers\/([^/]+)\/([a-z/-]+)$/u.exec(url);

      if (url === '/api/daemons/me') {
        send({
          data: {
            id: 'e2e-daemon',
            memberId: 'e2e-member',
            label: 'shutdown e2e',
            osType: 'WINDOWS',
            runnerVersion: null,
            supportedEngines: [],
            lastSeenAt: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        return;
      }
      if (url === '/api/daemon-triggers/poll-state') {
        polls += 1;
        const triggerId = pendingTriggerId;
        pendingTriggerId = null;
        send({
          data: {
            orphanedCancelRequestedTriggerIds: [],
            pendingWorktreeRemovals: [],
            pendingTrigger: triggerId
              ? {
                  id: triggerId,
                  prompt: 'wait',
                  runnerType: 'OPENCODE',
                  model: null,
                  fastMode: false,
                  effort: null,
                  idleTimeoutMs: null,
                  status: 'PENDING',
                  agentConfigId: 'e2e-agent',
                  startedAt: null,
                  errorMessage: null,
                  worktreeError: null,
                  lastHeartbeatAt: null,
                  conversationId: null,
                  parentTriggerId: null,
                  createdByMemberId: 'e2e-member',
                  targetDaemonId: null,
                  planMode: false,
                  claimedByDaemonId: null,
                  useWorktree: false,
                  baseBranch: null,
                  worktreeId: null,
                  worktreeStatus: null,
                  createdAt: now,
                  updatedAt: now,
                }
              : null,
          },
        });
        return;
      }
      if (triggerMatch?.[2] === 'runtime') {
        send({
          data: {
            triggerId: triggerMatch[1],
            agentConfigId: 'e2e-agent',
            authPath: workDir,
            apiKey: 'e2e-key',
            teamId: 'e2e-team',
            projectId: 'e2e-project',
            runnerPrompt: 'wait until stopped',
            parentHistoryMarkdown: null,
            useWorktree: false,
            baseBranch: null,
            worktreeId: null,
            conventions: [],
          },
        });
        return;
      }
      if (triggerMatch?.[2] === 'status' && request.method === 'PATCH') {
        const parsed = JSON.parse(body) as { status: string; errorMessage?: string };
        statusReports.push({
          triggerId: triggerMatch[1] ?? '',
          status: parsed.status,
          errorMessage: parsed.errorMessage,
        });
        send({ data: {} });
        return;
      }
      if (url.startsWith('/api/daemon-triggers/cancel-status/')) {
        send({ data: { cancelRequested: false } });
        return;
      }
      if (url === '/api/daemon-triggers/discovery-repositories') {
        send({ data: { repositories: [] } });
        return;
      }
      send({ data: {} });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    statusReports,
    pollCount: () => polls,
    offerTrigger: (triggerId) => {
      pendingTriggerId = triggerId;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async <T>(
  description: string,
  timeoutMs: number,
  probe: () => T | null | undefined | false,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
};

type Fixture = {
  root: string;
  home: string;
  workDir: string;
  enginePidFile: string;
  env: NodeJS.ProcessEnv;
  api: FakeApi;
  spawned: ChildProcess[];
  readPidRecord: () => { pid: number; instanceId: string; readyAt: string | null } | null;
  startRunner: () => ChildProcess;
  runnerLog: () => string;
  runCli: (command: string) => Promise<{ status: number | null; output: string }>;
  runHarness: (name: string, code: string) => Promise<{ status: number | null; output: string }>;
  dispose: () => Promise<void>;
};

const createFixture = async (): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), 'agentrunner-shutdown-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const prefix = join(root, 'npm');
  const enginePidFile = join(root, 'engine.pid');
  mkdirSync(home, { recursive: true });
  // 러너는 git 저장소나 AgentTeams 프로젝트가 아닌 폴더에서는 실행을 시작하지 않는다.
  mkdirSync(join(workDir, '.agentteams'), { recursive: true });
  writeFileSync(join(workDir, '.agentteams', 'config.json'), '{}', 'utf8');
  mkdirSync(join(prefix, 'node_modules', 'fake-engine'), { recursive: true });

  // 가짜 엔진: `run`으로 불리면 자기 PID를 남기고 끝나지 않는다. 설치 탐지·모델 열거가 부르는 다른 인자는 즉시 끝낸다.
  writeFileSync(
    join(prefix, 'node_modules', 'fake-engine', 'main.js'),
    [
      "if (process.argv[2] !== 'run') { console.log('fake-engine 1.0.0'); process.exit(0); }",
      `require('node:fs').writeFileSync(${JSON.stringify(enginePidFile)}, String(process.pid));`,
      "console.log(JSON.stringify({ type: 'text', text: 'working' }));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  const engineShim = join(prefix, 'fake-engine.cmd');
  writeFileSync(
    engineShim,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-engine\\main.js" %*',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const api = await startFakeApi(workDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    AGENTTEAMS_DAEMON_TOKEN: 'e2e-token',
    AGENTTEAMS_API_URL: api.url,
    POLLING_INTERVAL_MS: '300',
    MAX_POLLING_INTERVAL_MS: '300',
    RUNNER_CMD: engineShim,
  };
  delete env.AGENTTEAMS_RESTART_HANDOFF_ID;
  const spawned: ChildProcess[] = [];
  const pidFile = join(home, '.agentteams', 'daemon.pid');
  const runnerLogPath = join(root, 'runner.log');

  // 기동 하네스: 실제 `runStartCommand`를 쓰되, 고정 이름의 작업 스케줄러 작업을 건드리는 마이그레이션만 끈다.
  const startHarness = join(root, 'start-harness.mjs');
  writeFileSync(
    startHarness,
    [
      `import { runStartCommand } from ${JSON.stringify(sourceUrl('commands/start.ts'))};`,
      'await runStartCommand({ migrateWindowsAutostartOnBoot: async () => {} });',
    ].join('\n'),
    'utf8',
  );

  // 비동기로 실행한다. spawnSync는 이 프로세스의 이벤트 루프를 막아 가짜 API가 러너의 보고에 답하지 못하게 한다.
  const runNode = (args: string[]): Promise<{ status: number | null; output: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, ...args], { cwd: daemonRoot, env, windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, output }));
    });

  return {
    root,
    home,
    workDir,
    enginePidFile,
    env,
    api,
    spawned,
    readPidRecord: () => {
      try {
        return JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; instanceId: string; readyAt: string | null };
      } catch {
        return null;
      }
    },
    startRunner: () => {
      // 러너 출력은 실패 진단용으로만 남긴다. 검증 근거는 테스트 API 수신 내용과 PID 생존 여부다.
      const logFd = openSync(runnerLogPath, 'a');
      const child = spawn(process.execPath, [tsxCli, startHarness], {
        cwd: daemonRoot,
        env,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      closeSync(logFd);
      spawned.push(child);
      return child;
    },
    runnerLog: () => {
      try {
        return readFileSync(runnerLogPath, 'utf8').slice(-4000);
      } catch {
        return '';
      }
    },
    runCli: (command) => runNode([join(sourceRoot, 'index.ts'), command]),
    runHarness: (name, code) => {
      const path = join(root, `${name}.mjs`);
      writeFileSync(path, code, 'utf8');
      return runNode([path]);
    },
    dispose: async () => {
      const pids = new Set<number>();
      for (const child of spawned) if (child.pid) pids.add(child.pid);
      const recordedPid = (() => {
        try {
          return (JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number }).pid;
        } catch {
          return null;
        }
      })();
      // PID 기록의 프로세스는 이 격리 프로필에서 이 테스트가 띄운 러너뿐이다.
      if (recordedPid) pids.add(recordedPid);
      if (existsSync(enginePidFile)) pids.add(Number(readFileSync(enginePidFile, 'utf8')));
      for (const pid of pids) {
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
        }
      }
      await api.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
};

const startRunnerWithActiveRun = async (
  fixture: Fixture,
  triggerId: string,
  notInstanceId?: string,
): Promise<{ runnerPid: number; instanceId: string; enginePid: number }> => {
  fixture.startRunner();
  const record = await waitFor('a ready runner instance', 60_000, () => {
    const current = fixture.readPidRecord();
    return current?.readyAt && current.instanceId !== notInstanceId ? current : null;
  });
  rmSync(fixture.enginePidFile, { force: true });
  fixture.api.offerTrigger(triggerId);
  const enginePid = await waitFor('the fake engine to start', 60_000, () =>
    existsSync(fixture.enginePidFile) ? Number(readFileSync(fixture.enginePidFile, 'utf8')) : null,
  ).catch((error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}
--- runner log ---
${fixture.runnerLog()}`);
  });
  assert.ok(isAlive(enginePid), 'the fake engine must be running before the stop');
  return { runnerPid: record.pid, instanceId: record.instanceId, enginePid };
};

test(
  'agentrunner stop on Windows cancels the active run, reports CANCELLED and leaves no engine behind',
  { skip: process.platform !== 'win32', timeout: 240_000 },
  async () => {
    const fixture = await createFixture();
    try {
      const { runnerPid, enginePid } = await startRunnerWithActiveRun(fixture, 'trigger-stop');

      const stop = await fixture.runCli('stop');

      // 러너 종료, 엔진 정리, 취소 보고는 서로 다른 결함이라 한 번에 비교해 어느 것이 빠졌는지 함께 드러낸다.
      assert.deepEqual(
        {
          stopExitCode: stop.status,
          runnerAlive: isAlive(runnerPid),
          engineAlive: isAlive(enginePid),
          statusReports: fixture.api.statusReports,
        },
        {
          stopExitCode: 0,
          runnerAlive: false,
          engineAlive: false,
          statusReports: [{ triggerId: 'trigger-stop', status: 'CANCELLED', errorMessage: SHUTDOWN_MESSAGE }],
        },
        `${stop.output}
--- runner log ---
${fixture.runnerLog()}`,
      );
      assert.equal(fixture.readPidRecord(), null, 'the PID record must be removed');

      // 이미 멈춘 러너에 대한 중복 요청은 실패가 아니라 "실행 중 아님"이다.
      assert.equal((await fixture.runCli('stop')).status, 0);
    } finally {
      await fixture.dispose();
    }
  },
);

test(
  'a command-line restart without a registered task cancels the active run and leaves exactly one new runner polling',
  { skip: process.platform !== 'win32', timeout: 300_000 },
  async () => {
    const fixture = await createFixture();
    try {
      const previous = await startRunnerWithActiveRun(fixture, 'trigger-restart');

      // 실제 `runRestartCommand`를 쓰되, 이 장비의 진짜 `AgentRunner` 작업을 보지 않도록 자동시작을 "등록 안 됨"으로
      // 고정하고, 교체 러너는 전역 설치본 대신 같은 소스 하네스로 띄운다.
      const startHarness = join(fixture.root, 'start-harness.mjs');
      const restart = await fixture.runHarness(
        'restart-harness',
        [
          `import { spawn } from 'node:child_process';`,
          `import { runRestartCommand } from ${JSON.stringify(sourceUrl('commands/restart.ts'))};`,
          `import { restartDaemon } from ${JSON.stringify(sourceUrl('daemon-control.ts'))};`,
          'await runRestartCommand({',
          '  restartDaemon: () =>',
          '    restartDaemon({',
          "      getAutostartStatus: () => ({ registered: false, platform: 'task-scheduler' }),",
          '      spawnDetachedDaemon: async () => {',
          `        spawn(process.execPath, [${JSON.stringify(tsxCli)}, ${JSON.stringify(startHarness)}], {`,
          "          detached: true, stdio: 'ignore', windowsHide: true, env: process.env,",
          `          cwd: ${JSON.stringify(daemonRoot)},`,
          '        }).unref();',
          '      },',
          '    }),',
          '});',
        ].join('\n'),
      );

      assert.deepEqual(
        {
          restartExitCode: restart.status,
          previousRunnerAlive: isAlive(previous.runnerPid),
          previousEngineAlive: isAlive(previous.enginePid),
          statusReports: fixture.api.statusReports,
        },
        {
          restartExitCode: 0,
          previousRunnerAlive: false,
          previousEngineAlive: false,
          statusReports: [{ triggerId: 'trigger-restart', status: 'CANCELLED', errorMessage: SHUTDOWN_MESSAGE }],
        },
        `${restart.output}
--- runner log ---
${fixture.runnerLog()}`,
      );

      const replacement = fixture.readPidRecord();
      assert.ok(replacement?.readyAt, 'a ready replacement must own the PID record');
      assert.notEqual(replacement.instanceId, previous.instanceId);
      assert.ok(isAlive(replacement.pid));
      const pollsBefore = fixture.api.pollCount();
      await waitFor('the replacement runner to poll', 30_000, () => fixture.api.pollCount() >= pollsBefore + 2);
    } finally {
      await fixture.dispose();
    }
  },
);
