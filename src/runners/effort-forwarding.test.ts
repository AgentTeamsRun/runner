import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAntigravityExecArgs, toPowerShellEncodedCommand as antigravityPowerShell } from './antigravity.js';
import { buildCopilotCliArgs, toPowerShellEncodedCommand as copilotPowerShell } from './copilot-cli.js';
import { buildGrokBuildArgs, toGrokBuildPowerShellEncodedCommand } from './grok-build.js';
import { buildOmpArgs, toOmpPowerShellEncodedCommand } from './omp.js';
import { buildRunnerChildEnv } from './session-env.js';
import type { RunnerOptions } from './types.js';
import { buildOpenCodeRunArgs, toOpenCodePowerShellEncodedCommand } from './opencode.js';

const adapters = [
  {
    name: 'OpenCode',
    flag: '--variant',
    args: (effort?: string | null) => buildOpenCodeRunArgs('provider/model', effort),
    windows: (effort?: string | null) =>
      toOpenCodePowerShellEncodedCommand('C:/bin/opencode.exe', 'hello', 'provider/model', effort),
  },
  {
    name: 'Copilot',
    flag: '--effort',
    args: (effort?: string | null) => buildCopilotCliArgs('hello', 'model', effort),
    windows: (effort?: string | null) => copilotPowerShell('C:/bin/copilot.cmd', 'C:/prompt.txt', 'model', effort),
  },
  {
    name: 'OMP',
    flag: '--thinking',
    args: (effort?: string | null) => buildOmpArgs('/prompt.txt', '/repo', 'provider/model', effort),
    windows: (effort?: string | null) =>
      toOmpPowerShellEncodedCommand('C:/bin/omp.exe', 'C:/prompt.txt', 'C:/repo', 'provider/model', effort),
  },
  {
    name: 'Antigravity',
    flag: '--effort',
    args: (effort?: string | null) =>
      buildAntigravityExecArgs('hello', '/repo/.agentteams', '/log', 1000, 'gemini-3.8-flash', effort),
    windows: (effort?: string | null) =>
      antigravityPowerShell(
        'C:/bin/agy.exe',
        'hello',
        'C:/repo/.agentteams',
        'C:/log',
        1000,
        'gemini-3.8-flash',
        effort,
      ),
  },
  {
    name: 'Grok',
    flag: '--reasoning-effort',
    args: (effort?: string | null) => buildGrokBuildArgs('/prompt.txt', '/repo', 'grok-4.6', effort),
    windows: (effort?: string | null) =>
      toGrokBuildPowerShellEncodedCommand('C:/bin/grok.exe', 'C:/prompt.txt', 'C:/repo', 'grok-4.6', effort),
  },
];

for (const adapter of adapters) {
  test(`${adapter.name}: 잘못된 값도 무음 대체하지 않고 단일 인자로 보존한다`, () => {
    // API가 허용 집합을 검증한다. 어댑터가 임의 fallback을 만들거나 셸 코드로 해석하면 안 된다.
    for (const effort of ['bogus', "high'; Write-Output INJECTED; #", 'low', 'high']) {
      const args = adapter.args(effort);
      assert.equal(args.filter((arg) => arg === adapter.flag).length, 1);
      assert.equal(args[args.indexOf(adapter.flag) + 1], effort);
      const script = Buffer.from(adapter.windows(effort), 'base64').toString('utf16le');
      assert.ok(script.includes(`'${adapter.flag}' '${effort.replaceAll("'", "''")}'`));
      // 구버전의 unknown option 등 하위 CLI 실패를 PowerShell 성공으로 덮지 않는다.
      assert.ok(script.endsWith('exit $LASTEXITCODE'));
    }
  });

  test(`${adapter.name}: 양쪽 플랫폼에서 effort 기본값을 강제하지 않는다`, () => {
    for (const effort of [undefined, null, '', '   ']) {
      assert.equal(adapter.args(effort).includes(adapter.flag), false);
      const script = Buffer.from(adapter.windows(effort), 'base64').toString('utf16le');
      assert.equal(script.includes(adapter.flag), false);
    }
  });
}

test('effort 전달은 상속 환경을 수정하지 않고 현재 실행의 인자로만 확정한다', () => {
  const inherited = { AGENTTEAMS_MODEL: 'previous-model', AGENTTEAMS_FAST_MODE: 'true', PROVIDER_OPTION: 'keep' };
  const before = { ...inherited };
  const options: RunnerOptions = {
    triggerId: 'effort-env',
    runnerType: 'OMP',
    prompt: 'hello',
    authPath: '/repo',
    apiKey: 'test',
    apiUrl: 'https://example.test',
    teamId: 'team',
    projectId: 'project',
    agentConfigId: 'agent',
    timeoutMs: 1000,
    idleTimeoutMs: 1000,
    model: 'current-model',
    effort: 'low',
    fastMode: false,
  };
  const env = buildRunnerChildEnv(inherited, options);
  assert.equal(env.AGENTTEAMS_MODEL, 'current-model');
  assert.equal(env.AGENTTEAMS_FAST_MODE, undefined);
  assert.equal(env.PROVIDER_OPTION, 'keep');
  assert.deepEqual(inherited, before);
  for (const adapter of adapters) {
    const args = adapter.args(options.effort);
    assert.equal(args[args.indexOf(adapter.flag) + 1], 'low');
  }
});
