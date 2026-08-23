import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeAutoUpdate, resetAutoUpdateState } from './auto-update.js';

const require = createRequire(import.meta.url);
const installedRunnerVersion = (require('../../package.json') as { version: string }).version;

test('maybeAutoUpdate calls onUpdateSucceeded after successful install', async () => {
  resetAutoUpdateState();

  let installCalled = false;
  let notifiedVersion: string | null = null;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        installCalled = true;
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => Date.now(),
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      notifiedVersion = input.version;
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);

  assert.ok(installCalled, 'installPackage should be called');
  assert.equal(notifiedVersion, '99.9.9', 'onUpdateSucceeded should be called with new version');
});

test('maybeAutoUpdate does not call onUpdateSucceeded again if it already succeeded for that version', async () => {
  resetAutoUpdateState();

  let installCount = 0;
  let notifyCount = 0;

  const deps = {
    runExecutableSync: () => {
      installCount++;
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => Date.now(),
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async () => {
      notifyCount++;
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  // First call
  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1);
  assert.equal(notifyCount, 1);

  // Second call with same version
  await maybeAutoUpdate(meta, { ...deps, now: () => Date.now() + 60 * 60 * 1000 + 1 });
  assert.equal(installCount, 1, 'should not install again');
  assert.equal(notifyCount, 1, 'should not notify again');
});

/**
 * 실측 재현 로그(리눅스 systemd --user, npm prefix -g = /usr/local):
 * `npm install -g` 자식 프로세스가 EACCES(errno -13)로 죽는다.
 */
const EACCES_INSTALL_ERROR_MESSAGE = [
  'Command failed: /usr/bin/npm install -g @agentteams/runner@99.9.9',
  'npm ERR! code EACCES',
  'npm ERR! syscall rename',
  'npm ERR! path /usr/local/lib/node_modules/@agentteams/runner',
  'npm ERR! errno -13',
].join('\n');

const EEXIST_INSTALL_ERROR_MESSAGE = [
  'Command failed: /usr/bin/npm install -g @agentteams/runner@99.9.9',
  'npm ERR! code EEXIST',
  'npm ERR! path /usr/local/bin/agr',
  'npm ERR! File exists: /usr/local/bin/agr',
].join('\n');

test('maybeAutoUpdate reports EACCES install failure as PERMISSION_DENIED exactly once', async () => {
  resetAutoUpdateState();

  const failures: Array<{ package: string; version: string; reason: string; message: string }> = [];

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        throw new Error(EACCES_INSTALL_ERROR_MESSAGE);
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 20000000,
    // 프리플라이트는 통과시키고 설치 자체가 EACCES로 죽는 경로를 재현한다.
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async (input: { package: string; version: string; reason: string; message: string }) => {
      failures.push(input);
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);

  assert.equal(failures.length, 1, 'onUpdateFailed should be called exactly once');
  assert.equal(failures[0]?.package, 'runner');
  assert.equal(failures[0]?.version, '99.9.9');
  assert.equal(failures[0]?.reason, 'PERMISSION_DENIED');
});

test('maybeAutoUpdate does not retry a permission-blocked install within 24 hours', async () => {
  resetAutoUpdateState();

  let installCount = 0;
  let failureCount = 0;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        installCount++;
        throw new Error(EACCES_INSTALL_ERROR_MESSAGE);
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 20000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async () => {
      failureCount++;
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1, 'first poll should attempt the install');
  assert.equal(failureCount, 1, 'first poll should report the failure');

  // 기존 1시간 쿨다운은 지났지만 권한 차단 백오프(24시간) 안이므로 재시도하지 않는다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 20000000 + 2 * 60 * 60 * 1000 });

  assert.equal(installCount, 1, 'should not retry install within the permission-blocked backoff');
  assert.equal(failureCount, 1, 'should not report the same failure again');
});

test('maybeAutoUpdate does not retry a global bin conflict within 24 hours', async () => {
  resetAutoUpdateState();

  let installCount = 0;
  const failures: Array<{ reason: string; message: string }> = [];
  const warnings: string[] = [];

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        installCount++;
        throw new Error(EEXIST_INSTALL_ERROR_MESSAGE);
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
    now: () => 20000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async (input: { reason: string; message: string }) => {
      failures.push(input);
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1);
  // 서버로 가는 reason 계약은 넓히지 않았으므로 UNKNOWN 그대로 보고한다.
  assert.equal(failures[0]?.reason, 'UNKNOWN');
  assert.match(failures[0]?.message ?? '', /remove or rename that file/u);
  assert.equal(warnings.length, 1, 'the remediation hint should be logged once per target version');

  // 1시간 쿨다운은 지났지만 사용자 조치 대기 백오프(24시간) 안이므로 재시도하지 않는다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 20000000 + 2 * 60 * 60 * 1000 });
  assert.equal(installCount, 1, 'should not retry install within the manual-fix backoff');
  assert.equal(failures.length, 1, 'should not report the same failure again');

  // 24시간이 지나면 다시 시도한다 — 사용자가 충돌 파일을 치웠을 수 있다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 20000000 + 25 * 60 * 60 * 1000 });
  assert.equal(installCount, 2, 'should retry once the manual-fix backoff elapses');
});

test('maybeAutoUpdate RETRIES notification if it failed before', async () => {
  resetAutoUpdateState();

  let notifyCount = 0;
  let shouldFailNotify = true;

  const deps = {
    runExecutableSync: () => '',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 10000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async () => {
      if (shouldFailNotify) {
        shouldFailNotify = false;
        throw new Error('Network error');
      }
      notifyCount++;
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  // First call: install succeeds, notification fails
  console.log('First call starting...');
  await maybeAutoUpdate(meta, deps);
  console.log('First call done. notifyCount:', notifyCount);
  assert.equal(notifyCount, 0, 'Notification should have failed');

  // Second call: after cooldown
  console.log('Second call starting...');
  await maybeAutoUpdate(meta, { ...deps, now: () => 10000000 + 60 * 60 * 1000 + 1 });
  console.log('Second call done. notifyCount:', notifyCount);

  assert.equal(notifyCount, 1, 'Should retry notification successfully');
});

test('maybeAutoUpdate skips the install entirely when the global npm root is not writable', async () => {
  resetAutoUpdateState();

  const commands: Array<{ name: string; args: string[] }> = [];
  const failures: Array<{ package: string; version: string; reason: string }> = [];
  const warnings: string[] = [];

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      commands.push({ name, args });
      return '';
    },
    logger: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
    now: () => 30000000,
    canWriteGlobalNpmRoot: () => false,
    onUpdateFailed: async (input: { package: string; version: string; reason: string; message: string }) => {
      failures.push(input);
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);

  assert.equal(
    commands.filter((command) => command.name === 'npm' && command.args[0] === 'install').length,
    0,
    'npm install -g should not run when the preflight says the global npm root is not writable',
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, 'PERMISSION_DENIED');
  assert.equal(warnings.length, 1, 'the remediation hint should be logged once per target version');
});

test('maybeAutoUpdate falls back to attempting the install when the preflight cannot decide', async () => {
  resetAutoUpdateState();

  let installCalled = false;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        installCalled = true;
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 40000000,
    canWriteGlobalNpmRoot: () => {
      throw new Error('npm prefix -g failed');
    },
    onUpdateFailed: async () => {},
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);

  assert.ok(installCalled, 'fail-open: an undecidable preflight must not block the install');
});

test('maybeAutoUpdate retries immediately when the permission-blocked target version changes', async () => {
  resetAutoUpdateState();

  let installCount = 0;
  const failures: Array<{ version: string }> = [];

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        installCount++;
        throw new Error('npm ERR! code EACCES');
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 50000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async (input: { package: string; version: string; reason: string; message: string }) => {
      failures.push(input);
    },
  };

  await maybeAutoUpdate({ cliLatestVersion: null, runnerLatestVersion: '99.9.9' }, deps);
  assert.equal(installCount, 1);

  // 대상 버전이 바뀌면 24시간 백오프와 무관하게 다시 시도한다(1시간 쿨다운만 적용).
  await maybeAutoUpdate(
    { cliLatestVersion: null, runnerLatestVersion: '99.9.10' },
    { ...deps, now: () => 50000000 + 60 * 60 * 1000 + 1 },
  );

  assert.equal(installCount, 2, 'a new target version should be attempted again');
  assert.deepEqual(
    failures.map((failure) => failure.version),
    ['99.9.9', '99.9.10'],
  );
});

test('maybeAutoUpdate retries the failure report when the server call failed', async () => {
  resetAutoUpdateState();

  let reportAttempts = 0;
  let shouldFailReport = true;

  const deps = {
    runExecutableSync: () => '',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 60000000,
    canWriteGlobalNpmRoot: () => false,
    onUpdateFailed: async () => {
      reportAttempts++;
      if (shouldFailReport) {
        shouldFailReport = false;
        throw new Error('Network error');
      }
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(reportAttempts, 1);

  // 보고 실패는 수렴 대상이 아니다. 24시간 백오프가 지난 뒤 다시 보고를 시도한다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 60000000 + 24 * 60 * 60 * 1000 + 1 });
  assert.equal(reportAttempts, 2, 'a failed report should be retried');

  // 보고에 성공했으면 같은 대상 버전으로 다시 보내지 않는다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 60000000 + 48 * 60 * 60 * 1000 + 2 });
  assert.equal(reportAttempts, 2, 'a succeeded report should converge to once per target version');
});

test('maybeAutoUpdate retries the failure report on the next poll even while the install is permission-blocked', async () => {
  resetAutoUpdateState();

  let installCount = 0;
  let reportAttempts = 0;
  let shouldFailReport = true;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        installCount++;
        throw new Error(EACCES_INSTALL_ERROR_MESSAGE);
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 70000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async () => {
      reportAttempts++;
      if (shouldFailReport) {
        shouldFailReport = false;
        throw new Error('Network error');
      }
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1);
  assert.equal(reportAttempts, 1, 'the first poll should attempt the report');

  // 설치는 24시간 권한 백오프에 걸려 있어도, 미전송 보고는 바로 다음 폴링에서 재시도된다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 70000000 + 60 * 1000 });
  assert.equal(installCount, 1, 'the install must stay inside the permission-blocked backoff');
  assert.equal(reportAttempts, 2, 'an unsent failure report must be retried on the very next poll');

  // 보고에 성공했으면 같은 (version, reason)으로 다시 보내지 않는다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 70000000 + 2 * 60 * 1000 });
  assert.equal(reportAttempts, 2, 'a succeeded report should converge');
});

test('maybeAutoUpdate reports a changed failure reason for the same target version', async () => {
  resetAutoUpdateState();

  const failures: Array<{ version: string; reason: string }> = [];
  let installError = new Error('npm ERR! network timeout');

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        throw installError;
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 80000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async (input: { package: string; version: string; reason: string; message: string }) => {
      failures.push(input);
    },
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: '99.9.9',
  };

  await maybeAutoUpdate(meta, deps);
  assert.deepEqual(
    failures.map((failure) => failure.reason),
    ['UNKNOWN'],
  );

  // 같은 대상 버전이라도 사유가 바뀌면 서버가 새 상태로 취급하므로 다시 보고해야 한다.
  installError = new Error(EACCES_INSTALL_ERROR_MESSAGE);
  await maybeAutoUpdate(meta, { ...deps, now: () => 80000000 + 60 * 60 * 1000 + 1 });
  assert.deepEqual(
    failures.map((failure) => failure.reason),
    ['UNKNOWN', 'PERMISSION_DENIED'],
  );

  // 완전히 동일한 (version, reason)만 억제된다.
  await maybeAutoUpdate(meta, { ...deps, now: () => 80000000 + 25 * 60 * 60 * 1000 });
  assert.equal(failures.length, 2, 'an identical (version, reason) report must be suppressed');
});

test('maybeAutoUpdate attempts a new target version immediately after a permission failure', async () => {
  resetAutoUpdateState();

  const attemptedVersions: string[] = [];

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'install') {
        attemptedVersions.push(String(args[2]));
        throw new Error(EACCES_INSTALL_ERROR_MESSAGE);
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 90000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateFailed: async () => {},
  };

  await maybeAutoUpdate({ cliLatestVersion: null, runnerLatestVersion: '99.9.9' }, deps);
  assert.deepEqual(attemptedVersions, ['@agentteams/runner@99.9.9']);

  // 실패 직후 1분 만에 새 버전이 배포되면 쿨다운을 기다리지 않고 즉시 시도한다.
  await maybeAutoUpdate(
    { cliLatestVersion: null, runnerLatestVersion: '99.9.10' },
    { ...deps, now: () => 90000000 + 60 * 1000 },
  );
  assert.deepEqual(attemptedVersions, ['@agentteams/runner@99.9.9', '@agentteams/runner@99.9.10']);
});

test('maybeAutoUpdate reports a CLI install success so the server can clear the CLI failure', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];
  const failures: Array<{ package: string; version: string; reason: string }> = [];
  let canWrite = false;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'list') {
        return JSON.stringify({ dependencies: { '@agentteams/cli': { version: '1.0.0' } } });
      }
      return '';
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 100000000,
    canWriteGlobalNpmRoot: () => canWrite,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      successes.push(input);
    },
    onUpdateFailed: async (input: { package: string; version: string; reason: string; message: string }) => {
      failures.push(input);
    },
  };

  const meta = {
    cliLatestVersion: '1.1.0',
    runnerLatestVersion: null,
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(failures.length, 1, 'the blocked CLI install should be reported');
  assert.equal(failures[0]?.package, 'cli');
  assert.equal(successes.length, 0);

  // 사용자가 권한을 고친 뒤 새 대상 버전이 나오면 즉시 재시도되고, 성공은 패키지와 함께 보고된다.
  canWrite = true;
  await maybeAutoUpdate(
    { cliLatestVersion: '1.1.1', runnerLatestVersion: null },
    { ...deps, canWriteGlobalNpmRoot: () => canWrite, now: () => 100000000 + 60 * 1000 },
  );

  assert.deepEqual(successes, [{ package: 'cli', version: '1.1.1' }]);
});

const installedCliVersion = (version: string) => (name: string, args: string[]) => {
  if (name === 'npm' && args[0] === 'list') {
    return JSON.stringify({ dependencies: { '@agentteams/cli': { version } } });
  }
  throw new Error(`unexpected command: ${name} ${args.join(' ')}`);
};

test('maybeAutoUpdate reports CLI success once when the installed version is already latest', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];
  let now = 110000000;

  const deps = {
    runExecutableSync: installedCliVersion('1.2.3'),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => now,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      successes.push(input);
    },
  };

  const meta = {
    cliLatestVersion: '1.2.3',
    runnerLatestVersion: null,
  };

  await maybeAutoUpdate(meta, deps);
  await maybeAutoUpdate(meta, deps);
  now += 60 * 1000;
  await maybeAutoUpdate(meta, deps);

  assert.deepEqual(successes, [{ package: 'cli', version: '1.2.3' }]);
});

test('maybeAutoUpdate retries the already-latest CLI success report if the first notify throws', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];
  let shouldFail = true;

  const deps = {
    runExecutableSync: installedCliVersion('2.0.0'),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 120000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Network error');
      }
      successes.push(input);
    },
  };

  const meta = {
    cliLatestVersion: '2.0.0',
    runnerLatestVersion: null,
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(successes.length, 0);

  await maybeAutoUpdate(meta, deps);
  assert.deepEqual(successes, [{ package: 'cli', version: '2.0.0' }]);
});

test('maybeAutoUpdate does not report runner success when the installed runner is already latest', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];

  const deps = {
    runExecutableSync: () => {
      throw new Error('runner already-latest path must not install');
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 130000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      successes.push(input);
    },
  };

  await maybeAutoUpdate({ cliLatestVersion: null, runnerLatestVersion: installedRunnerVersion }, deps);

  assert.deepEqual(successes, []);
});

test('maybeAutoUpdate does not report CLI success when the installed version cannot be read', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];

  const deps = {
    runExecutableSync: () => {
      throw new Error('npm list failed');
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 140000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      successes.push(input);
    },
  };

  await maybeAutoUpdate({ cliLatestVersion: '3.0.0', runnerLatestVersion: null }, deps);

  assert.deepEqual(successes, []);
});

test('resetAutoUpdateState allows another already-latest CLI success report', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];

  const deps = {
    runExecutableSync: installedCliVersion('4.0.0'),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => 150000000,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      successes.push(input);
    },
  };

  const meta = {
    cliLatestVersion: '4.0.0',
    runnerLatestVersion: null,
  };

  await maybeAutoUpdate(meta, deps);
  assert.equal(successes.length, 1);

  resetAutoUpdateState();
  await maybeAutoUpdate(meta, deps);
  assert.deepEqual(successes, [
    { package: 'cli', version: '4.0.0' },
    { package: 'cli', version: '4.0.0' },
  ]);
});

test('maybeAutoUpdate clears a permission-blocked CLI failure once the user installs it manually', async () => {
  resetAutoUpdateState();

  const successes: Array<{ package: string; version: string }> = [];
  const failures: Array<{ package: string; version: string; reason: string }> = [];
  let installedCli = '1.0.0';
  let installCount = 0;
  let now = 200000000;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'list') {
        return JSON.stringify({ dependencies: { '@agentteams/cli': { version: installedCli } } });
      }
      if (name === 'npm' && args[0] === 'install') {
        installCount++;
        throw new Error(EACCES_INSTALL_ERROR_MESSAGE);
      }
      throw new Error(`unexpected command: ${name} ${args.join(' ')}`);
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => now,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async (input: { package: string; version: string }) => {
      successes.push(input);
    },
    onUpdateFailed: async (input: { package: string; version: string; reason: string }) => {
      failures.push({ package: input.package, version: input.version, reason: input.reason });
    },
  };

  const meta = { cliLatestVersion: '3.0.0', runnerLatestVersion: null };

  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1);
  assert.deepEqual(failures, [{ package: 'cli', version: '3.0.0', reason: 'PERMISSION_DENIED' }]);

  // 사용자가 안내대로 직접 설치했다. 설치는 24시간 백오프에 갇혀 있지만 최신 여부 프로브는 따로 돌아야 한다.
  installedCli = '3.0.0';

  now += 60 * 1000;
  await maybeAutoUpdate(meta, deps);
  assert.deepEqual(successes, [], '프로브 주기(5분) 안에서는 다시 확인하지 않는다');

  now += 5 * 60 * 1000;
  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1, '자가 해제 프로브가 설치 백오프를 깨뜨려서는 안 된다');
  assert.deepEqual(
    successes,
    [{ package: 'cli', version: '3.0.0' }],
    '24시간 백오프를 기다리지 않고 성공 보고로 서버의 차단 상태를 해제해야 한다',
  );

  // 해제 이후에는 차단 상태가 없으므로 프로브도 멈추고 같은 보고를 반복하지 않는다.
  now += 10 * 60 * 1000;
  await maybeAutoUpdate(meta, deps);
  assert.deepEqual(successes, [{ package: 'cli', version: '3.0.0' }]);
});

test('maybeAutoUpdate does not probe the installed CLI version while no failure is pending', async () => {
  resetAutoUpdateState();

  let listCount = 0;
  let now = 210000000;

  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === 'npm' && args[0] === 'list') {
        listCount++;
        return JSON.stringify({ dependencies: { '@agentteams/cli': { version: '1.0.0' } } });
      }
      if (name === 'npm' && args[0] === 'install') {
        return '';
      }
      throw new Error(`unexpected command: ${name} ${args.join(' ')}`);
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => now,
    canWriteGlobalNpmRoot: () => true,
    onUpdateSucceeded: async () => {},
  };

  const meta = { cliLatestVersion: '3.0.0', runnerLatestVersion: null };

  await maybeAutoUpdate(meta, deps);
  assert.equal(listCount, 1);

  // 설치가 성공한 뒤에는 차단 상태가 없다 — 설치 쿨다운(1시간) 밖의 프로브가 추가로 돌면 안 된다.
  now += 30 * 60 * 1000;
  await maybeAutoUpdate(meta, deps);
  assert.equal(listCount, 1, '차단 상태가 없으면 설치 주기 밖에서 npm list를 돌리지 않는다');
});
