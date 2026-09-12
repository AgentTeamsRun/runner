import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeInstalledEngines } from './engine-probe.js';

describe('probeInstalledEngines', () => {
  it('returns only installed engines and resolves the npm global prefix once per cycle', async () => {
    let npmGlobalPrefixCalls = 0;
    const result = await probeInstalledEngines('custom-opencode', {
      getNpmGlobalPrefixAsync: async () => {
        npmGlobalPrefixCalls += 1;
        return '/global/prefix';
      },
      resolveExecutablePathWithPreferenceAsync: async (name, _preferredNames, deps) => {
        assert.equal(deps?.npmGlobalPrefix, '/global/prefix');
        return name === 'codex' ? '/bin/codex' : null;
      },
    });

    assert.deepEqual(result.engines, ['CODEX']);
    assert.equal(result.reliable, true);
    assert.equal(npmGlobalPrefixCalls, 1);
  });

  it('uses the configured OpenCode command and absorbs individual probe failures', async () => {
    const requestedCommands: string[] = [];
    const result = await probeInstalledEngines('custom-opencode', {
      getNpmGlobalPrefixAsync: async () => null,
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
      getNpmGlobalPrefixAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async (name, preferredNames) => {
        preferences.set(name, preferredNames);
        return null;
      },
    });

    assert.deepEqual(preferences.get('claude'), ['claude.cmd', 'claude']);
    assert.deepEqual(preferences.get('kimi'), ['kimi.cmd', 'kimi']);
    assert.deepEqual(preferences.get('kiro-cli'), ['kiro-cli.exe', 'kiro-cli']);
    assert.deepEqual(preferences.get('agent'), ['cursor-agent', 'agent']);
    assert.deepEqual(preferences.get('grok'), ['grok.exe', 'grok']);
  });

  // 리눅스 공식 설치 스크립트는 opencode를 PATH 밖 $HOME/.opencode/bin에 두고 PATH 보강은
  // 셸 rc에만 넣는다. 러너는 비대화형이라 rc를 읽지 않으므로, 알려진 설치 경로 폴백이 없으면
  // 정상 설치된 OpenCode가 탐지에서 통째로 빠진다(2026-08-24 linux-dev 재현).
  it('detects OpenCode installed at the official Linux path outside PATH', async () => {
    const result = await probeInstalledEngines('opencode', {
      platform: () => 'linux',
      env: { HOME: '/home/justin' },
      // PATH 조회(`which -a`)와 `npm prefix -g`가 모두 실패하는 상황을 그대로 재현한다.
      execFileAsync: (async () => {
        throw new Error('not found');
      }) as never,
      existsSync: ((path: string) =>
        path === '/home/justin/.opencode/bin/opencode') as typeof import('node:fs').existsSync,
      runProbeCommand: async () => null,
    });

    assert.deepEqual(result.engines, ['OPENCODE']);
    assert.equal(result.reliable, true);
  });

  it('accepts Cursor only when the executable identifies itself as Cursor Agent', async () => {
    const probe = (helpText: string | null) =>
      probeInstalledEngines('opencode', {
        getNpmGlobalPrefixAsync: async () => null,
        runProbeCommand: async () => helpText,
        resolveExecutablePathWithPreferenceAsync: async (name) => (name === 'agent' ? '/bin/agent' : null),
      });

    assert.deepEqual((await probe('Start the Cursor Agent')).engines, ['CURSOR_CLI']);
    assert.deepEqual((await probe('Unrelated agent utility')).engines, []);
    // 타임아웃으로 죽은 --help는 null을 돌려주며, 오탐 대신 미설치로 취급한다.
    assert.deepEqual((await probe(null)).engines, []);
  });

  // Grok Build 설치기가 만드는 `agent` 별칭이 PATH 앞에 있어도, 뒤에 있는 진짜 Cursor 설치를 찾아야 한다.
  it('accepts Cursor when a Grok agent alias precedes the real Cursor Agent in PATH', async () => {
    const result = await probeInstalledEngines('opencode', {
      getNpmGlobalPrefixAsync: async () => null,
      runProbeCommand: async (path) => (path.includes('.grok') ? 'Grok Build TUI' : 'Start the Cursor Agent'),
      resolveExecutablePathsWithPreferenceAsync: async (name) =>
        name === 'agent' ? ['/home/me/.grok/bin/agent', '/home/me/.local/bin/agent'] : [],
      resolveExecutablePathWithPreferenceAsync: async () => null,
    });

    assert.deepEqual(result.engines, ['CURSOR_CLI']);
  });

  // `grok`은 무관한 npm 패키지(@vibe-kit/grok-cli)도 쓰는 이름이라, 공식 help 문구가 없으면
  // 설치된 것으로 보고하면 안 된다. 서드파티를 GROK_BUILD로 오탐하면 실행이 통째로 깨진다.
  it('accepts Grok only when the executable identifies itself as Grok Build', async () => {
    const probe = (helpText: string | null) =>
      probeInstalledEngines('opencode', {
        getNpmGlobalPrefixAsync: async () => null,
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
      getNpmGlobalPrefixAsync: async () => null,
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

  it('accepts omp only when the executable identifies itself as Oh My Pi', async () => {
    const probe = (helpText: string | null) =>
      probeInstalledEngines('opencode', {
        getNpmGlobalPrefixAsync: async () => null,
        runProbeCommand: async () => helpText,
        resolveExecutablePathWithPreferenceAsync: async (name) => (name === 'omp' ? '/bin/omp' : null),
      });

    assert.deepEqual((await probe('omp v18.0.4\nOh My Pi as an ACP')).engines, ['OMP']);
    assert.deepEqual((await probe('omp 1.0.0\nnew ')).engines, []);
    assert.deepEqual((await probe(null)).engines, []);
  });

  it('accepts muse only when the executable identifies itself as muse — interactive terminal coding agent', async () => {
    const probe = (helpText: string | null) =>
      probeInstalledEngines('opencode', {
        getNpmGlobalPrefixAsync: async () => null,
        runProbeCommand: async () => helpText,
        resolveExecutablePathWithPreferenceAsync: async (name) => (name === 'muse' ? '/bin/muse' : null),
      });

    assert.deepEqual((await probe('muse — interactive terminal coding agent')).engines, ['MUSE_CODE']);
    assert.deepEqual((await probe('A CMS Scaffolding Tool')).engines, []);
    assert.deepEqual((await probe(null)).engines, []);
  });

  // 빈 목록은 서버에서 "제한 없음"으로 해석되므로, 조회 자체가 불가능한 환경은 보고 대상에서 빼야 한다.
  it('marks a zero-engine result unreliable when the lookup command cannot run', async () => {
    const result = await probeInstalledEngines('opencode', {
      getNpmGlobalPrefixAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async () => null,
      isExecutableLookupAvailable: async () => false,
    });

    assert.deepEqual(result.engines, []);
    assert.equal(result.reliable, false);
  });

  it('keeps a zero-engine result reliable when the lookup command works', async () => {
    const result = await probeInstalledEngines('opencode', {
      getNpmGlobalPrefixAsync: async () => null,
      resolveExecutablePathWithPreferenceAsync: async () => null,
      isExecutableLookupAvailable: async () => true,
    });

    assert.deepEqual(result.engines, []);
    assert.equal(result.reliable, true);
  });
});
