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
    assert.deepEqual(preferences.get('grok'), ['grok.exe', 'grok']);
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

  // `grok`은 무관한 npm 패키지(@vibe-kit/grok-cli)도 쓰는 이름이라, 공식 help 문구가 없으면
  // 설치된 것으로 보고하면 안 된다. 서드파티를 GROK_BUILD로 오탐하면 실행이 통째로 깨진다.
  it('accepts Grok only when the executable identifies itself as Grok Build', async () => {
    const probe = (helpText: string | null) =>
      probeInstalledEngines('opencode', {
        getNpmGlobalBinPathAsync: async () => null,
        runProbeCommand: async () => helpText,
        resolveExecutablePathWithPreferenceAsync: async (name) => (name === 'grok' ? '/bin/grok' : null),
      });

    assert.deepEqual((await probe('Grok Build TUI\n\nUsage: grok [OPTIONS] [PROMPT]')).engines, ['GROK_BUILD']);
    // 서드파티 @vibe-kit/grok-cli의 help에는 이 문구가 없다.
    assert.deepEqual((await probe('Grok CLI - AI assistant in your terminal')).engines, []);
    assert.deepEqual((await probe(null)).engines, []);
  });

  it('skips a conflicting Grok candidate and accepts the next official installation', async () => {
    const probed: string[] = [];
    const result = await probeInstalledEngines('opencode', {
      getNpmGlobalBinPathAsync: async () => null,
      resolveExecutablePathsWithPreferenceAsync: async (name) =>
        name === 'grok' ? ['/custom/bin/grok', '/usr/local/bin/grok'] : [],
      resolveExecutablePathWithPreferenceAsync: async () => null,
      runProbeCommand: async (executablePath) => {
        probed.push(executablePath);
        return executablePath === '/usr/local/bin/grok' ? 'Grok Build TUI' : 'Grok CLI - AI assistant';
      },
    });

    assert.deepEqual(probed, ['/custom/bin/grok', '/usr/local/bin/grok']);
    assert.deepEqual(result.engines, ['GROK_BUILD']);
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
