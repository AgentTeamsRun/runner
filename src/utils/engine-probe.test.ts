import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeInstalledEngines } from './engine-probe.js';

describe('probeInstalledEngines', () => {
  it('returns only installed engines and resolves npm global bin once per cycle', async () => {
    let npmGlobalBinCalls = 0;
    const result = await probeInstalledEngines('custom-opencode', {
      getNpmGlobalBinPathAsync: async () => {
        npmGlobalBinCalls += 1;
        return '/global/bin';
      },
      resolveExecutablePathWithPreferenceAsync: async (name, _preferredNames, deps) => {
        assert.equal(deps?.npmGlobalBinPath, '/global/bin');
        return name === 'codex' ? '/bin/codex' : null;
      },
    });

    assert.deepEqual(result.engines, ['CODEX']);
    assert.equal(result.reliable, true);
    assert.equal(npmGlobalBinCalls, 1);
  });

  it('uses the configured OpenCode command and absorbs individual probe failures', async () => {
    const requestedCommands: string[] = [];
    const result = await probeInstalledEngines('custom-opencode', {
      getNpmGlobalBinPathAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async (name) => {
        requestedCommands.push(name);
        return name === 'custom-opencode' ? '/bin/custom-opencode' : null;
      },
    });

    assert.equal(requestedCommands[0], 'custom-opencode');
    assert.deepEqual(result.engines, ['OPENCODE']);
  });

  // 탐지와 실제 기동이 갈리지 않도록 러너 모듈과 같은 선호 목록을 넘겨야 한다.
  it('passes the same executable preference the runners use', async () => {
    const preferences = new Map<string, string[]>();
    await probeInstalledEngines('opencode', {
      platform: () => 'win32',
      getNpmGlobalBinPathAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async (name, preferredNames) => {
        preferences.set(name, preferredNames);
        return null;
      },
    });

    assert.deepEqual(preferences.get('claude'), ['claude.cmd', 'claude']);
    assert.deepEqual(preferences.get('kimi'), ['kimi.cmd', 'kimi']);
    assert.deepEqual(preferences.get('kiro-cli'), ['kiro-cli.exe', 'kiro-cli']);
    assert.deepEqual(preferences.get('agent'), ['agent']);
  });

  it('accepts Cursor only when the executable identifies itself as Cursor Agent', async () => {
    const probe = (helpText: string | null) =>
      probeInstalledEngines('opencode', {
        getNpmGlobalBinPathAsync: async () => null,
        runProbeCommand: async () => helpText,
        resolveExecutablePathWithPreferenceAsync: async (name) => (name === 'agent' ? '/bin/agent' : null),
      });

    assert.deepEqual((await probe('Start the Cursor Agent')).engines, ['CURSOR_CLI']);
    assert.deepEqual((await probe('Unrelated agent utility')).engines, []);
    // 타임아웃으로 죽은 --help는 null을 돌려주며, 오탐 대신 미설치로 취급한다.
    assert.deepEqual((await probe(null)).engines, []);
  });

  // 빈 목록은 서버에서 "제한 없음"으로 해석되므로, 조회 자체가 불가능한 환경은 보고 대상에서 빼야 한다.
  it('marks a zero-engine result unreliable when the lookup command cannot run', async () => {
    const result = await probeInstalledEngines('opencode', {
      getNpmGlobalBinPathAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async () => null,
      isExecutableLookupAvailable: async () => false,
    });

    assert.deepEqual(result.engines, []);
    assert.equal(result.reliable, false);
  });

  it('keeps a zero-engine result reliable when the lookup command works', async () => {
    const result = await probeInstalledEngines('opencode', {
      getNpmGlobalBinPathAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async () => null,
      isExecutableLookupAvailable: async () => true,
    });

    assert.deepEqual(result.engines, []);
    assert.equal(result.reliable, true);
  });
});
