import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWindowsTaskXmlContent,
  getWindowsTaskMigrationReason,
  parseWindowsTaskPriority,
  windowsTaskNeedsMigration,
  WINDOWS_TASK_DEFAULT_PRIORITY,
  WINDOWS_TASK_MIGRATION_DESCRIPTIONS,
  WINDOWS_TASK_PRIORITY,
} from './autostart.js';
import { runStatusCommand } from './commands/status.js';
import { restartWindowsTask } from './autostart.js';
import { terminateDaemonInstance, waitForDaemonToStart } from './daemon-control.js';
import { runRestartCommand } from './commands/restart.js';

/**
 * 2026-09-17 Windows 실측 재현 (Windows 11 26200, runner 0.0.133,
 * launcher sha256 1854bd81…f737):
 *
 * - `agentrunner restart`가 재시작 이전 PID 12600만 살아 있는 상태에서 성공을 보고했다.
 * - 예약 작업이 시작한 러너는 `<Priority>` 기본값 7(BELOW_NORMAL 클래스) 때문에
 *   CPU 포화 상태에서 기아 상태에 빠져 ntdll/kernel32만 로드한 채 진행하지 못했다.
 *   동일한 액션을 우선순위만 바꿔 실행한 결과 5는 0.4초, 6은 0.7초에 끝났고,
 *   7은 150초 제한 안에 시작조차 하지 못했다.
 *
 * 두 결함 모두 아래 테스트로 고정한다.
 */

const LAUNCHER_PATH = 'C:\\Users\\runner\\.agentteams\\bin\\agentrunner-launcher-0.0.133-1854bd81b217.exe';
const WRAPPER_PATH = 'C:\\Users\\runner\\.agentteams\\agentrunner-start.ps1';
const USER_ID = 'DOMAIN\\runner';

const buildTaskXml = (): string => buildWindowsTaskXmlContent(USER_ID, LAUNCHER_PATH, WRAPPER_PATH);

const buildInstalledTaskXml = (settings: string): string =>
  [
    '<Task>',
    `<Settings>${settings}</Settings>`,
    `<Actions><Exec><Command>${LAUNCHER_PATH}</Command></Exec></Actions>`,
    '</Task>',
  ].join('');

const advancingClock = (stepMs: number) => {
  let value = 0;
  return () => (value += stepMs);
};

// --- 재시작 완료 판정 ---

test('waitForDaemonToStart does not accept the pre-restart instance as a completed restart', async () => {
  const confirmation = await waitForDaemonToStart({
    previousInstance: { pid: 12600, instanceId: 'instance-before-restart' },
    // 예약 작업만 /Run 되고 새 인스턴스가 기동하지 못한 실제 상황: PID 파일은
    // 재시작 이전 인스턴스를 그대로 가리킨다.
    getDaemonStatus: async () => ({ running: true, pid: 12600, instanceId: 'instance-before-restart', ready: true }),
    sleep: async () => undefined,
    now: advancingClock(5_000),
    timeoutMs: 15_000,
  });

  assert.equal(confirmation.replaced, false);
  assert.equal(confirmation.stage, 'stale-instance');
});

test('waitForDaemonToStart treats a reused PID with a new instance id as a real replacement', async () => {
  const confirmation = await waitForDaemonToStart({
    previousInstance: { pid: 12600, instanceId: 'instance-before-restart' },
    getDaemonStatus: async () => ({ running: true, pid: 12600, instanceId: 'instance-after-restart', ready: true }),
    sleep: async () => undefined,
    now: () => 0,
  });

  assert.equal(confirmation.replaced, true);
  assert.equal(confirmation.stage, 'replaced');
  assert.equal(confirmation.pid, 12600);
});

test('waitForDaemonToStart rejects a replacement that never finished initializing', async () => {
  const confirmation = await waitForDaemonToStart({
    previousInstance: { pid: 12600, instanceId: 'instance-before-restart' },
    // 새 프로세스가 PID 파일은 썼지만 폴링 준비까지 도달하지 못한 상태.
    getDaemonStatus: async () => ({ running: true, pid: 23100, instanceId: 'instance-after-restart', ready: false }),
    sleep: async () => undefined,
    now: advancingClock(5_000),
    timeoutMs: 15_000,
  });

  assert.equal(confirmation.replaced, false);
  assert.equal(confirmation.stage, 'not-ready');
});

test('waitForDaemonToStart reports a replacement that exited immediately as not running', async () => {
  const confirmation = await waitForDaemonToStart({
    previousInstance: { pid: 12600, instanceId: 'instance-before-restart' },
    getDaemonStatus: async () => ({ running: false, pid: null, instanceId: null, ready: false }),
    sleep: async () => undefined,
    now: advancingClock(5_000),
    timeoutMs: 15_000,
  });

  assert.equal(confirmation.replaced, false);
  assert.equal(confirmation.stage, 'not-running');
});

test('restart command fails and reports the stage when only the pre-restart instance survives', async () => {
  const terminated: Array<{ pid: number; instanceId: string | null }> = [];

  await assert.rejects(
    runRestartCommand({
      restartDaemon: async () => ({ previousInstance: { pid: 12600, instanceId: 'instance-before-restart' } }),
      waitForDaemonToStart: async () => ({
        running: true,
        pid: 12600,
        instanceId: 'instance-before-restart',
        replaced: false,
        stage: 'stale-instance',
      }),
      terminateDaemonInstance: async (instance) => {
        terminated.push(instance);
      },
      logger: { info: () => undefined, warn: () => undefined },
    }),
    (error: Error) => {
      assert.match(error.message, /stale-instance/u);
      assert.match(error.message, /12600/u);
      return true;
    },
  );

  // 기존 인스턴스가 예약 작업 소유가 아니면 /End로 종료되지 않으므로, 실패를 알리기
  // 전에 기록된 PID를 명시적으로 정리해 중복 인스턴스가 남지 않게 한다.
  assert.deepEqual(terminated, [{ pid: 12600, instanceId: 'instance-before-restart' }]);
});

test('restart command succeeds only after a different instance reports ready', async () => {
  const logs: Array<Record<string, unknown> | undefined> = [];

  await runRestartCommand({
    restartDaemon: async () => ({ previousInstance: { pid: 12600, instanceId: 'instance-before-restart' } }),
    waitForDaemonToStart: async () => ({
      running: true,
      pid: 23100,
      instanceId: 'instance-after-restart',
      replaced: true,
      stage: 'replaced',
    }),
    terminateDaemonInstance: async () => {
      throw new Error('a successful replacement must not terminate anything');
    },
    logger: { info: (_message, context) => logs.push(context), warn: () => undefined },
  });

  assert.deepEqual(logs, [{ pid: 23100, previousPid: 12600 }]);
});

test('terminateDaemonInstance stops the recorded PID and watches that PID only', async () => {
  const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
  let alive = true;

  await terminateDaemonInstance(
    { pid: 12600, instanceId: 'instance-before-restart' },
    {
      verifyRecordedDaemonInstance: async () => 'verified',
      kill: (pid, signal) => {
        signals.push({ pid, signal });
        alive = false;
        return true;
      },
      // 교체 러너가 이미 PID 파일을 가져갔더라도 종료 판정은 이 PID만 본다.
      isProcessRunning: () => alive,
      sleep: async () => undefined,
      now: () => 0,
    },
  );

  assert.deepEqual(signals, [{ pid: 12600, signal: 'SIGTERM' }]);
});

test('terminateDaemonInstance reports a timeout instead of pretending the instance stopped', async () => {
  await assert.rejects(
    terminateDaemonInstance(
      { pid: 12600, instanceId: 'instance-before-restart' },
      {
        verifyRecordedDaemonInstance: async () => 'verified',
        kill: () => true,
        isProcessRunning: () => true,
        sleep: async () => undefined,
        now: advancingClock(5_000),
        timeoutMs: 10_000,
      },
    ),
    /Timed out waiting for AgentRunner process 12600 to stop/u,
  );
});

// --- 재시작 순서: 교체 전에 이전 인스턴스를 비운다 ---

/**
 * 2026-09-18 설치 패키지 통합 검증에서 드러난 실패:
 * `schtasks /End`는 예약 작업의 프로세스 트리만 종료하고, Job Object를 벗어난
 * 손자 node 러너는 살아남는다. 살아남은 러너가 래퍼가 append 하는 로그 파일을
 * 잡고 있어 교체 러너는 한 줄도 쓰지 못하고 exit 1로 죽었고(작업 결과 1),
 * 재시작은 그 뒤 stale-instance로 실패했다. `/Run` 전에 기록된 인스턴스를
 * 식별자 기준으로 비워야 한다.
 */
test('restartWindowsTask stops a recorded instance that outlived the task before /Run', async () => {
  const commands: string[] = [];
  const signalled: Array<{ pid: number; signal: string }> = [];
  let alive = true;

  await restartWindowsTask(null, {
    execSync: (command) => {
      commands.push(command);
      return Buffer.from(/-EncodedCommand/u.test(command) ? '3' : '');
    },
    // 작업은 stopped인데 기록된 러너는 아직 살아 있는 상태.
    getDaemonStatus: async () => ({ running: true, pid: 13300, instanceId: 'before', ready: true }),
    verifyRecordedDaemonInstance: async () => 'verified',
    kill: (pid, signal) => {
      signalled.push({ pid, signal });
      alive = false;
      return true;
    },
    isProcessRunning: () => alive,
    sleep: async () => undefined,
    now: () => 0,
  });

  assert.deepEqual(signalled, [{ pid: 13300, signal: 'SIGTERM' }]);
  const schtasks = commands.filter((command) => command.startsWith('schtasks'));
  assert.deepEqual(schtasks, ['schtasks /End /TN "AgentRunner" 2>nul', 'schtasks /Run /TN "AgentRunner"']);
  // 종료 신호는 /Run 앞에서 일어나야 한다.
  assert.equal(signalled.length, 1);
});

test('restartWindowsTask aborts /Run when the recorded instance refuses to stop', async () => {
  const commands: string[] = [];
  let clock = 0;

  await assert.rejects(
    restartWindowsTask(null, {
      execSync: (command) => {
        commands.push(command);
        return Buffer.from(/-EncodedCommand/u.test(command) ? '3' : '');
      },
      getDaemonStatus: async () => ({ running: true, pid: 13300, instanceId: 'before', ready: true }),
      verifyRecordedDaemonInstance: async () => 'verified',
      kill: () => true,
      isProcessRunning: () => true,
      sleep: async () => undefined,
      now: () => {
        const value = clock;
        clock += 16_000; // 30초 제한을 넘긴다
        return value;
      },
    }),
    /pid 13300\) did not stop before the restart/u,
  );

  assert.ok(!commands.some((command) => command.startsWith('schtasks /Run')));
});

// --- 자동시작 기동 정지 ---

test('the Windows task action runs at a normal scheduling priority', () => {
  const xml = buildTaskXml();

  // Task Scheduler의 기본값은 7(BELOW_NORMAL 클래스)이고, 그 값에서 러너 기동이
  // CPU 포화 상태에서 무기한 기아 상태에 빠지는 것이 실측으로 확인됐다.
  assert.ok(WINDOWS_TASK_PRIORITY <= 6, 'the task must not run below the NORMAL priority class');
  assert.match(xml, new RegExp(`<Priority>${WINDOWS_TASK_PRIORITY}</Priority>`, 'u'));
  assert.equal(parseWindowsTaskPriority(xml), WINDOWS_TASK_PRIORITY);
});

test('parseWindowsTaskPriority reports the Task Scheduler default when the element is absent', () => {
  assert.equal(
    parseWindowsTaskPriority('<Task><Settings><Hidden>true</Hidden></Settings></Task>'),
    WINDOWS_TASK_DEFAULT_PRIORITY,
  );
  assert.equal(WINDOWS_TASK_DEFAULT_PRIORITY, 7);
});

test('an installed task without a priority element is migrated', () => {
  const legacyXml = buildInstalledTaskXml('<Hidden>true</Hidden>');

  assert.equal(
    windowsTaskNeedsMigration({ execSync: () => legacyXml }),
    true,
    'a native-launcher task stuck at the starving default priority must still migrate',
  );
});

test('an installed task that already carries a normal priority is left alone', () => {
  const currentXml = buildInstalledTaskXml(`<Hidden>true</Hidden><Priority>${WINDOWS_TASK_PRIORITY}</Priority>`);

  assert.equal(windowsTaskNeedsMigration({ execSync: () => currentXml }), false);
});

test('the migration verdict names which of the two defects it found', () => {
  assert.equal(
    getWindowsTaskMigrationReason({ execSync: () => buildInstalledTaskXml('<Hidden>true</Hidden>') }),
    'below-normal-priority',
  );
  assert.equal(
    getWindowsTaskMigrationReason({
      execSync: () => '<Task><Actions><Exec><Command>powershell.exe</Command></Exec></Actions></Task>',
    }),
    'console-bound-action',
  );
});

test('status names the starving priority instead of reporting a console-bound action', async () => {
  const warnings: string[] = [];

  await runStatusCommand({
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: true, pid: 4321, instanceId: 'instance', ready: true }),
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    getWindowsTaskMigrationReason: () => 'below-normal-priority',
    logger: { info: () => undefined, warn: (message: string) => warnings.push(message) },
  });

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes(WINDOWS_TASK_MIGRATION_DESCRIPTIONS['below-normal-priority']));
  assert.doesNotMatch(warnings[0]!, /console-bound/u);
});

test('an unreadable task definition never triggers a needless re-registration', () => {
  assert.equal(
    windowsTaskNeedsMigration({
      execSync: () => {
        throw new Error('schtasks is unavailable');
      },
    }),
    false,
  );
});

// --- 기존 계약 characterization ---

test('the task action keeps the hidden, delimited native launcher contract', () => {
  const xml = buildTaskXml();

  assert.match(xml, /<Hidden>true<\/Hidden>/u);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(xml, /<Command>[^<]*agentrunner-launcher-[^<]*\.exe<\/Command>/u);
  assert.match(xml, /--exec &quot;[^&]*powershell\.exe&quot;/u);
  assert.match(xml, /-WindowStyle Hidden/u);
  assert.doesNotMatch(xml, /AGENTTEAMS_DAEMON_TOKEN/u);
});

// --- 코드리뷰 후속: 업그레이드 첫 재시작과 재사용된 PID ---

/**
 * 구형 러너가 남긴 맨 PID 파일에는 instanceId가 없다. 업그레이드 후 첫
 * `agentrunner restart`에서 교체 러너가 그 PID를 물려받으면, 식별자를 PID 비교로
 * 되돌릴 경우 정상 교체가 stale-instance로 오판되고 건강한 교체 러너가 종료된다.
 */
test('waitForDaemonToStart treats the first restart after an upgrade as a real replacement', async () => {
  const confirmation = await waitForDaemonToStart({
    // 구형 레코드에는 식별자가 없다.
    previousInstance: { pid: 12600, instanceId: null },
    getDaemonStatus: async () => ({ running: true, pid: 12600, instanceId: 'instance-after-restart', ready: true }),
    sleep: async () => undefined,
    now: () => 0,
  });

  assert.equal(confirmation.replaced, true);
  assert.equal(confirmation.stage, 'replaced');
});

test('terminateDaemonInstance never signals a PID that now belongs to someone else', async () => {
  const signals: number[] = [];
  let pidFileRemoved = false;

  await terminateDaemonInstance(
    { pid: 12600, instanceId: 'instance-before-restart' },
    {
      verifyRecordedDaemonInstance: async () => 'mismatch',
      removePidFile: async () => {
        pidFileRemoved = true;
      },
      kill: (pid) => {
        signals.push(pid);
        return true;
      },
      isProcessRunning: () => true,
      sleep: async () => undefined,
      now: () => 0,
      logger: { warn: () => undefined },
    },
  );

  assert.deepEqual(signals, []);
  assert.equal(pidFileRemoved, true);
});

test('restartWindowsTask discards a stale record instead of killing the process that reused its PID', async () => {
  const commands: string[] = [];
  const signals: number[] = [];
  let pidFileRemoved = false;

  await restartWindowsTask(null, {
    execSync: (command) => {
      commands.push(command);
      return Buffer.from(/-EncodedCommand/u.test(command) ? '3' : '');
    },
    getDaemonStatus: async () => ({ running: true, pid: 13300, instanceId: 'before', ready: true }),
    verifyRecordedDaemonInstance: async () => 'mismatch',
    removePidFile: async () => {
      pidFileRemoved = true;
    },
    kill: (pid) => {
      signals.push(pid);
      return true;
    },
    isProcessRunning: () => true,
    sleep: async () => undefined,
    now: () => 0,
  });

  assert.deepEqual(signals, []);
  assert.equal(pidFileRemoved, true);
  // 정지할 인스턴스가 없으므로 교체는 그대로 시작되어야 한다.
  assert.ok(commands.includes('schtasks /Run /TN "AgentRunner"'));
});

test('restart failure text never claims the stale instance was stopped when stopping failed', async () => {
  await assert.rejects(
    runRestartCommand({
      restartDaemon: async () => ({ previousInstance: { pid: 12600, instanceId: 'instance-before-restart' } }),
      waitForDaemonToStart: async () => ({
        running: true,
        pid: 12600,
        instanceId: 'instance-before-restart',
        replaced: false,
        stage: 'stale-instance',
      }),
      terminateDaemonInstance: async () => {
        throw new Error('Timed out waiting for AgentRunner process 12600 to stop.');
      },
      logger: { info: () => undefined, warn: () => undefined },
    }),
    (error: Error) => {
      assert.match(error.message, /Stopping it also failed/u);
      assert.match(error.message, /stop it manually/u);
      // 정지에 실패했는데 `agentrunner start`를 안내하면 중복 기동을 유도한다.
      assert.ok(!/run `agentrunner start`/u.test(error.message));
      return true;
    },
  );
});

test('status surfaces a runner that is running but never finished initializing', async () => {
  const warnings: string[] = [];

  await runStatusCommand({
    platform: () => 'win32',
    getDaemonStatus: async () => ({ running: true, pid: 12600, instanceId: 'stalled', ready: false }),
    getAutostartStatus: () => ({ registered: true, platform: 'task-scheduler' }),
    getWindowsTaskMigrationReason: () => null,
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /never finished initializing/u);
});
