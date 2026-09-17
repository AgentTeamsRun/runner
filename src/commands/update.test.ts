import assert from 'node:assert/strict';
import test from 'node:test';
import { runUpdateCommand } from './update.js';

test('runUpdateCommand installs latest package and restarts daemon', async () => {
  const commandCalls: Array<{ name: string; args: string[] }> = [];
  const logs: string[] = [];
  let restarted = false;

  await runUpdateCommand({
    runExecutableSync: (name, args) => {
      commandCalls.push({ name, args });
      if (args[0] === 'view') {
        return '0.0.13\n';
      }

      return '';
    },
    restartDaemon: async () => {
      restarted = true;
      return { previousInstance: null };
    },
    waitForDaemonToStart: async () => ({
      running: true,
      pid: 23100,
      instanceId: 'instance-after-update',
      replaced: true,
      stage: 'replaced' as const,
    }),
    logger: {
      info: (message) => {
        logs.push(message);
      },
      warn: () => undefined,
    },
  });

  assert.deepEqual(commandCalls, [
    {
      name: 'npm',
      args: ['view', '@agentteams/runner', 'version'],
    },
    {
      name: 'npm',
      args: ['install', '-g', '@agentteams/runner@latest'],
    },
  ]);
  assert.equal(restarted, true);
  assert.deepEqual(logs, ['Updating AgentRunner package', 'Package update completed', 'AgentRunner update completed']);
});

test('runUpdateCommand continues update when latest version lookup fails', async () => {
  const commandCalls: Array<{ name: string; args: string[] }> = [];
  const warnings: string[] = [];

  await runUpdateCommand({
    runExecutableSync: (name, args) => {
      commandCalls.push({ name, args });
      if (args[0] === 'view') {
        throw new Error('network unavailable');
      }

      return '';
    },
    restartDaemon: async () => ({ previousInstance: null }),
    waitForDaemonToStart: async () => ({
      running: true,
      pid: 23100,
      instanceId: 'instance-after-update',
      replaced: true,
      stage: 'replaced' as const,
    }),
    logger: {
      info: () => undefined,
      warn: (message) => {
        warnings.push(message);
      },
    },
  });

  assert.equal(warnings.length, 1);
  assert.deepEqual(commandCalls, [
    {
      name: 'npm',
      args: ['view', '@agentteams/runner', 'version'],
    },
    {
      name: 'npm',
      args: ['install', '-g', '@agentteams/runner@latest'],
    },
  ]);
});

test('runUpdateCommand surfaces a friendly message when global npm install needs permissions', async () => {
  await assert.rejects(
    () =>
      runUpdateCommand({
        runExecutableSync: (_name, args) => {
          if (args[0] === 'view') {
            return '0.0.13\n';
          }

          throw new Error('npm ERR! code EACCES');
        },
        restartDaemon: async () => ({ previousInstance: null }),
        waitForDaemonToStart: async () => ({
          running: true,
          pid: 23100,
          instanceId: 'instance-after-update',
          replaced: true,
          stage: 'replaced' as const,
        }),
        logger: {
          info: () => undefined,
          warn: () => undefined,
        },
      }),
    /Global npm install requires elevated permissions/u,
  );
});

test('runUpdateCommand surfaces install failures with command context', async () => {
  await assert.rejects(
    () =>
      runUpdateCommand({
        runExecutableSync: (_name, args) => {
          if (args[0] === 'view') {
            return '0.0.13\n';
          }

          throw new Error('registry unavailable');
        },
        restartDaemon: async () => ({ previousInstance: null }),
        waitForDaemonToStart: async () => ({
          running: true,
          pid: 23100,
          instanceId: 'instance-after-update',
          replaced: true,
          stage: 'replaced' as const,
        }),
        logger: {
          info: () => undefined,
          warn: () => undefined,
        },
      }),
    /Failed to install the latest AgentRunner package: registry unavailable/u,
  );
});

test('runUpdateCommand fails when the replacement runner never takes over', async () => {
  const logs: string[] = [];

  await assert.rejects(
    () =>
      runUpdateCommand({
        runExecutableSync: (_name, args) => (args[0] === 'view' ? '0.0.13\n' : ''),
        restartDaemon: async () => ({ previousInstance: { pid: 12600, instanceId: 'instance-before-update' } }),
        // 교체 러너가 올라오지 않았는데도 성공을 보고하던 경로를 고정한다.
        waitForDaemonToStart: async () => ({
          running: false,
          pid: null,
          instanceId: null,
          replaced: false,
          stage: 'not-running' as const,
        }),
        logger: {
          info: (message) => {
            logs.push(message);
          },
          warn: () => undefined,
        },
      }),
    (error: Error) => {
      assert.match(error.message, /AgentRunner update was triggered but no runner reported running/u);
      assert.match(error.message, /stage: not-running/u);
      return true;
    },
  );

  assert.ok(!logs.includes('AgentRunner update completed'));
});

test('runUpdateCommand reports the replacement pid once a different instance is ready', async () => {
  const contexts: Array<Record<string, unknown> | undefined> = [];

  await runUpdateCommand({
    runExecutableSync: (_name, args) => (args[0] === 'view' ? '0.0.13\n' : ''),
    restartDaemon: async () => ({ previousInstance: { pid: 12600, instanceId: 'instance-before-update' } }),
    waitForDaemonToStart: async () => ({
      running: true,
      pid: 23100,
      instanceId: 'instance-after-update',
      replaced: true,
      stage: 'replaced' as const,
    }),
    logger: {
      info: (_message, context) => contexts.push(context as Record<string, unknown> | undefined),
      warn: () => undefined,
    },
  });

  const completion = contexts.at(-1);
  assert.equal(completion?.targetVersion, '0.0.13');
  assert.equal(completion?.pid, 23100);
  assert.equal(completion?.previousPid, 12600);
});
