import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPowerShellCommand,
  resolveExecutablePath,
  resolveExecutablePathsWithPreferenceAsync,
  resolveExecutablePathWithPreference,
  runProbeCommand,
} from './executable.js';

test('resolveExecutablePath falls back to npm global bin on Windows', () => {
  const resolved = resolveExecutablePath('opencode', {
    env: {
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    platform: () => 'win32',
    execFileSync: ((command: string, args: string[]) => {
      if (command === 'where') {
        throw new Error('not found');
      }

      if (command === 'npm' && args[0] === 'prefix') {
        return 'C:\\Users\\rlaru\\AppData\\Roaming\\npm\n';
      }

      throw new Error(`unexpected command: ${command}`);
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /AppData[\\/]+Roaming[\\/]+npm[\\/]+opencode\.cmd$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Roaming\\npm[\\/]opencode\.cmd$/u);
});

test('resolveExecutablePath prefers npm.cmd when Windows PATH lookup returns npm first', () => {
  const resolved = resolveExecutablePath('npm', {
    platform: () => 'win32',
    execFileSync: ((command: string, args: string[]) => {
      if (command === 'where' && args[0] === 'npm') {
        return 'C:\\nvm4w\\nodejs\\npm\nC:\\nvm4w\\nodejs\\npm.cmd\n';
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    }) as typeof import('node:child_process').execFileSync,
  });

  assert.equal(resolved, 'C:\\nvm4w\\nodejs\\npm.cmd');
});

test('resolveExecutablePath prefers a runnable extension over the extensionless POSIX shim on Windows', () => {
  const resolved = resolveExecutablePath('agentrunner', {
    platform: () => 'win32',
    execFileSync: ((command: string, args: string[]) => {
      if (command === 'where' && args[0] === 'agentrunner') {
        // `where` lists the #!/bin/sh shim first, then the runnable .cmd.
        return 'C:\\nvm4w\\nodejs\\agentrunner\nC:\\nvm4w\\nodejs\\agentrunner.cmd\n';
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    }) as typeof import('node:child_process').execFileSync,
  });

  assert.equal(resolved, 'C:\\nvm4w\\nodejs\\agentrunner.cmd');
});

test('resolveExecutablePath keeps the extensionless result when no runnable extension exists on Windows', () => {
  const resolved = resolveExecutablePath('mytool', {
    platform: () => 'win32',
    execFileSync: ((command: string, args: string[]) => {
      if (command === 'where' && args[0] === 'mytool') {
        return 'C:\\tools\\mytool\n';
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    }) as typeof import('node:child_process').execFileSync,
  });

  assert.equal(resolved, 'C:\\tools\\mytool');
});

test('resolveExecutablePath falls back to Antigravity local app bin on Windows', () => {
  const resolved = resolveExecutablePath('agy', {
    env: {
      LOCALAPPDATA: 'C:\\Users\\rlaru\\AppData\\Local',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    platform: () => 'win32',
    execFileSync: ((command: string, args?: readonly string[]) => {
      if (command === 'where') {
        throw new Error('not found');
      }

      if (command === 'npm' && args?.[0] === 'prefix') {
        throw new Error('npm unavailable');
      }

      throw new Error(`unexpected command: ${command}`);
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /AppData[\\/]+Local[\\/]+agy[\\/]+bin[\\/]+agy\.exe$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Local[\\/]agy[\\/]bin[\\/]agy\.exe$/u);
});

test('resolveExecutablePath falls back to the Kimi install bin outside Windows', () => {
  const resolved = resolveExecutablePath('kimi', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /^[/\\]Users[/\\]justin[/\\]\.kimi-code[/\\]bin[/\\]kimi$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /^[/\\]Users[/\\]justin[/\\]\.kimi-code[/\\]bin[/\\]kimi$/u);
});

for (const executable of ['claude', 'codex']) {
  test(`resolveExecutablePath falls back to the ${executable} user-local install bin outside Windows`, () => {
    const resolved = resolveExecutablePath(executable, {
      env: {
        HOME: '/Users/justin',
      },
      platform: () => 'darwin',
      execFileSync: (() => {
        throw new Error('not found');
      }) as unknown as typeof import('node:child_process').execFileSync,
      existsSync: ((path: string) =>
        path === `/Users/justin/.local/bin/${executable}`) as typeof import('node:fs').existsSync,
    });

    assert.equal(resolved, `/Users/justin/.local/bin/${executable}`);
  });
}

test('resolveExecutablePath reports known install paths when claude is absent', () => {
  assert.throws(
    () =>
      resolveExecutablePath('claude', {
        env: {
          HOME: '/Users/justin',
        },
        platform: () => 'linux',
        execFileSync: (() => {
          throw new Error('not found');
        }) as unknown as typeof import('node:child_process').execFileSync,
        existsSync: (() => false) as typeof import('node:fs').existsSync,
      }),
    /Checked PATH, npm global bin, and known app install paths/u,
  );
});

test('resolveExecutablePath falls back to the Kimi install bin on Windows', () => {
  const resolved = resolveExecutablePath('kimi', {
    env: {
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\justin',
    },
    platform: () => 'win32',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /^C:[/\\]Users[/\\]justin[/\\]\.kimi-code[/\\]bin[/\\]kimi\.cmd$/u.test(
        path,
      )) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /^C:[/\\]Users[/\\]justin[/\\]\.kimi-code[/\\]bin[/\\]kimi\.cmd$/u);
});

test('resolveExecutablePath keeps the missing Kimi executable error when the install bin is absent', () => {
  assert.throws(
    () =>
      resolveExecutablePath('kimi', {
        env: {
          HOME: '/Users/justin',
        },
        platform: () => 'darwin',
        execFileSync: (() => {
          throw new Error('not found');
        }) as unknown as typeof import('node:child_process').execFileSync,
        existsSync: (() => false) as typeof import('node:fs').existsSync,
      }),
    /Cannot find 'kimi' executable/u,
  );
});

test('resolveExecutablePath falls back to the Kiro install bin outside Windows', () => {
  const resolved = resolveExecutablePath('kiro-cli', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /^[/\\]Users[/\\]justin[/\\]\.local[/\\]bin[/\\]kiro-cli$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /^[/\\]Users[/\\]justin[/\\]\.local[/\\]bin[/\\]kiro-cli$/u);
});

test('resolveExecutablePath falls back to the macOS Kiro app bundle when the ~/.local/bin symlink is absent', () => {
  const resolved = resolveExecutablePath('kiro-cli', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli');
});

test('resolveExecutablePath keeps the missing Kiro executable error when no install path exists', () => {
  // Windows 설치 경로는 실측되지 않아 알려진 폴백이 없다. PATH에도 없으면 명확히 실패해야 한다.
  assert.throws(
    () =>
      resolveExecutablePath('kiro-cli', {
        env: {
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          USERPROFILE: 'C:\\Users\\justin',
        },
        platform: () => 'win32',
        execFileSync: (() => {
          throw new Error('not found');
        }) as unknown as typeof import('node:child_process').execFileSync,
        existsSync: (() => false) as typeof import('node:fs').existsSync,
      }),
    /Cannot find 'kiro-cli' executable/u,
  );
});

// opencode 공식 설치 스크립트(https://opencode.ai/install)는 실행 파일을 $HOME/.opencode/bin에
// 두고 PATH 보강은 .bashrc/.zshrc/.profile 같은 셸 rc에만 추가한다. 러너는 비대화형 프로세스라
// rc를 읽지 않으므로, 알려진 설치 경로 폴백이 없으면 정상 설치도 미설치로 오판한다.
// (2026-08-24 linux-dev 실측, opencode 1.18.21)
test('resolveExecutablePath falls back to the OpenCode install bin outside Windows', () => {
  const resolved = resolveExecutablePath('opencode', {
    env: {
      HOME: '/home/justin',
    },
    platform: () => 'linux',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/home/justin/.opencode/bin/opencode') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/home/justin/.opencode/bin/opencode');
});

test('resolveExecutablePath skips a same-name directory under the npm prefix', () => {
  const resolved = resolveExecutablePath('opencode', {
    env: { HOME: '/home/justin' },
    platform: () => 'linux',
    npmGlobalPrefix: '/home/justin',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/home/justin/opencode' ||
      path === '/home/justin/.opencode/bin/opencode') as typeof import('node:fs').existsSync,
    isFile: (path) => path === '/home/justin/.opencode/bin/opencode',
  });

  assert.equal(resolved, '/home/justin/.opencode/bin/opencode');
});

test('resolveExecutablePath keeps the missing OpenCode executable error on Windows', () => {
  // 공식 설치 스크립트는 bash 전용이라 Windows 설치 경로를 정의하지 않는다. 추측 경로를 넣지
  // 않으므로 Windows에서는 알려진 폴백 없이 PATH/npm 탐색에만 의존해야 한다.
  assert.throws(
    () =>
      resolveExecutablePath('opencode', {
        env: {
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          USERPROFILE: 'C:\\Users\\justin',
        },
        platform: () => 'win32',
        execFileSync: (() => {
          throw new Error('not found');
        }) as unknown as typeof import('node:child_process').execFileSync,
        existsSync: (() => false) as typeof import('node:fs').existsSync,
      }),
    /Cannot find 'opencode' executable\. Checked PATH and npm global bin/u,
  );
});

test('resolveExecutablePathWithPreference falls back to the Kiro install bin', () => {
  const resolved = resolveExecutablePathWithPreference('kiro-cli', ['kiro-cli'], {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'linux',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /^[/\\]Users[/\\]justin[/\\]\.local[/\\]bin[/\\]kiro-cli$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /^[/\\]Users[/\\]justin[/\\]\.local[/\\]bin[/\\]kiro-cli$/u);
});

test('resolveExecutablePathWithPreference falls back to the Kimi install bin', () => {
  const resolved = resolveExecutablePathWithPreference('kimi', ['kimi'], {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'linux',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /^[/\\]Users[/\\]justin[/\\]\.kimi-code[/\\]bin[/\\]kimi$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /^[/\\]Users[/\\]justin[/\\]\.kimi-code[/\\]bin[/\\]kimi$/u);
});

// `npm prefix -g`는 bin 디렉터리가 아니라 prefix를 돌려준다. POSIX에서 전역 실행 파일은
// `<prefix>/bin`에 놓이므로, prefix를 그대로 bin으로 취급하면 npm 전역 폴백이 통째로 죽는다
// (2026-08-24 linux-dev 실측: `npm prefix -g` → /home/justin/.local, 실행 파일은 /home/justin/.local/bin/*).
test('resolveExecutablePath resolves npm global installs from <prefix>/bin outside Windows', () => {
  // `amp`은 알려진 설치 경로 리졸버가 없어, npm 전역 폴백만 단독으로 검증할 수 있다.
  const resolved = resolveExecutablePath('amp', {
    env: {},
    platform: () => 'linux',
    execFileSync: ((command: string, args?: readonly string[]) => {
      if (command === 'which') {
        throw new Error('not found');
      }

      if (command === 'npm' && args?.[0] === 'prefix') {
        return '/home/justin/.local\n';
      }

      throw new Error(`unexpected command: ${command}`);
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) => path === '/home/justin/.local/bin/amp') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/home/justin/.local/bin/amp');
});

// 비표준 prefix 설정(실행 파일이 prefix 바로 아래 놓이는 환경)의 회귀를 만들지 않는다.
test('resolveExecutablePath still resolves npm global installs directly under the prefix', () => {
  const resolved = resolveExecutablePath('amp', {
    env: {},
    platform: () => 'linux',
    execFileSync: ((command: string, args?: readonly string[]) => {
      if (command === 'which') {
        throw new Error('not found');
      }

      if (command === 'npm' && args?.[0] === 'prefix') {
        return '/opt/npm-global\n';
      }

      throw new Error(`unexpected command: ${command}`);
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) => path === '/opt/npm-global/amp') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/opt/npm-global/amp');
});

test('resolveExecutablePath prefers PATH lookup results', () => {
  const resolved = resolveExecutablePath('codex', {
    platform: () => 'linux',
    execFileSync: ((command: string) => {
      if (command === 'which') {
        return '/usr/local/bin/codex\n';
      }

      throw new Error(`unexpected command: ${command}`);
    }) as typeof import('node:child_process').execFileSync,
  });

  assert.equal(resolved, '/usr/local/bin/codex');
});

for (const resolvedAgent of ['C:\\Cursor\\agent.exe', 'C:\\Users\\test\\AppData\\Local\\Cursor\\agent.cmd']) {
  test(`resolveExecutablePath accepts Cursor agent PATH result ${resolvedAgent.split('\\\\').at(-1)}`, () => {
    const resolved = resolveExecutablePath('agent', {
      platform: () => 'win32',
      execFileSync: ((command: string, args: string[]) => {
        if (command === 'where' && args[0] === 'agent') return `${resolvedAgent}\n`;
        throw new Error(`unexpected command: ${command}`);
      }) as unknown as typeof import('node:child_process').execFileSync,
    });
    assert.equal(resolved, resolvedAgent);
  });
}

test('resolveExecutablePathWithPreference prefers opencode.cmd on Windows', () => {
  const resolved = resolveExecutablePathWithPreference('opencode', ['opencode.cmd', 'opencode'], {
    platform: () => 'win32',
    execFileSync: ((command: string, args: string[]) => {
      if (command === 'where' && args[0] === 'opencode.cmd') {
        return 'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd\n';
      }

      if (command === 'where' && args[0] === 'opencode') {
        return 'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode\n';
      }

      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    }) as typeof import('node:child_process').execFileSync,
  });

  assert.equal(resolved, 'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd');
});

test('resolveExecutablePathWithPreference falls back to agy.exe for preferred agy names on Windows', () => {
  const resolved = resolveExecutablePathWithPreference('agy', ['agy.cmd', 'agy'], {
    env: {
      LOCALAPPDATA: 'C:\\Users\\rlaru\\AppData\\Local',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    platform: () => 'win32',
    execFileSync: ((command: string, args?: readonly string[]) => {
      if (command === 'where') {
        throw new Error('not found');
      }

      if (command === 'npm' && args?.[0] === 'prefix') {
        throw new Error('npm unavailable');
      }

      throw new Error(`unexpected command: ${command} ${args?.join(' ') ?? ''}`);
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      /AppData[\\/]+Local[\\/]+agy[\\/]+bin[\\/]+agy\.exe$/u.test(path)) as typeof import('node:fs').existsSync,
  });

  assert.match(resolved, /C:\\Users\\rlaru\\AppData\\Local[\\/]agy[\\/]bin[\\/]agy\.exe$/u);
});

test('buildPowerShellCommand preserves multiline arguments and escapes single quotes', () => {
  const command = buildPowerShellCommand('C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd', [
    'run',
    "line 1\nline '2'",
  ]);

  assert.equal(command, "& 'C:\\Users\\rlaru\\AppData\\Roaming\\npm\\opencode.cmd' 'run' 'line 1\nline ''2'''");
});

// `grok`은 무관한 npm 패키지(@vibe-kit/grok-cli)도 설치하는 이름이다. 기본 해석 순서
// (PATH → npm global bin → 알려진 설치 경로)를 그대로 두면 서드파티가 이기고, 그 CLI에는
// --output-format/--permission-mode가 없어 러너가 조용히 오작동한다.
test('resolveExecutablePath prefers the Grok install bin over a third-party grok on PATH', () => {
  const resolved = resolveExecutablePath('grok', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    // PATH 조회는 서드파티 npm shim을 먼저 돌려준다.
    execFileSync: (() =>
      '/Users/justin/.nvm/versions/node/v24.16.0/bin/grok\n') as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/Users/justin/.grok/bin/grok' ||
      path === '/Users/justin/.nvm/versions/node/v24.16.0/bin/grok') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/Users/justin/.grok/bin/grok');
});

test('resolveExecutablePath prefers the omp install bin over a third-party omp on PATH', () => {
  const resolved = resolveExecutablePath('omp', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() =>
      '/Users/justin/.nvm/versions/node/v24.16.0/bin/omp\n') as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/Users/justin/.local/bin/omp' ||
      path === '/Users/justin/.nvm/versions/node/v24.16.0/bin/omp') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/Users/justin/.local/bin/omp');
});

test('resolveExecutablePath honours GROK_HOME ahead of the default ~/.grok/bin', () => {
  const resolved = resolveExecutablePath('grok', {
    env: {
      HOME: '/Users/justin',
      GROK_HOME: '/opt/grok-home',
    },
    platform: () => 'linux',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/opt/grok-home/bin/grok' ||
      path === '/Users/justin/.grok/bin/grok') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/opt/grok-home/bin/grok');
});

// 공식 설치본이 없는 환경에서는 알려진 경로 탐색이 실패하고 기존 순서대로 PATH로 넘어가야 한다.
// (서드파티만 있는 환경의 동작을 바꾸지 않는다는 보장)
test('resolveExecutablePath still falls back to PATH when no official Grok install exists', () => {
  const resolved = resolveExecutablePath('grok', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() => '/usr/local/bin/grok\n') as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) => path === '/usr/local/bin/grok') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/usr/local/bin/grok');
});

test('resolveExecutablePathWithPreference prefers the Grok install bin over PATH', () => {
  const resolved = resolveExecutablePathWithPreference('grok', ['grok'], {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() =>
      '/Users/justin/.nvm/versions/node/v24.16.0/bin/grok\n') as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) =>
      path === '/Users/justin/.grok/bin/grok' ||
      path === '/Users/justin/.nvm/versions/node/v24.16.0/bin/grok') as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, '/Users/justin/.grok/bin/grok');
});

test('resolveExecutablePathsWithPreferenceAsync keeps every Grok candidate in priority order', async () => {
  const resolved = await resolveExecutablePathsWithPreferenceAsync('grok', ['grok'], {
    env: { HOME: '/Users/justin' },
    platform: () => 'darwin',
    npmGlobalPrefix: null,
    execFileAsync: (async () => ({
      stdout: '/usr/local/bin/grok\n/opt/homebrew/bin/grok\n',
      stderr: '',
    })) as never,
    existsSync: ((path: string) => path === '/Users/justin/.grok/bin/grok') as typeof import('node:fs').existsSync,
  });

  assert.deepEqual(resolved, ['/Users/justin/.grok/bin/grok', '/usr/local/bin/grok', '/opt/homebrew/bin/grok']);
});

test('runProbeCommand launches powershell.exe with -Command on Windows', async () => {
  const calls: Array<{ file: string; args: readonly string[] | undefined }> = [];
  const fakeExecFileAsync = (async (file: string, args: readonly string[] | undefined) => {
    calls.push({ file, args });
    return { stdout: 'Cursor Agent 1.0\n', stderr: '' };
  }) as never;

  const result = await runProbeCommand('C:\\tools\\agent.cmd', ['--help'], {
    platform: () => 'win32',
    execFileAsync: fakeExecFileAsync,
  });

  assert.equal(result, 'Cursor Agent 1.0\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, 'powershell.exe');
  assert.deepEqual(calls[0]?.args, [
    '-NoLogo',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "& 'C:\\tools\\agent.cmd' '--help'",
  ]);
});

test('runProbeCommand executes command directly on non-Windows', async () => {
  const calls: Array<{ file: string; args: readonly string[] | undefined }> = [];
  const fakeExecFileAsync = (async (file: string, args: readonly string[] | undefined) => {
    calls.push({ file, args });
    return { stdout: 'Cursor Agent 1.0\n', stderr: '' };
  }) as never;

  const result = await runProbeCommand('/usr/local/bin/agent', ['--help'], {
    platform: () => 'darwin',
    execFileAsync: fakeExecFileAsync,
  });

  assert.equal(result, 'Cursor Agent 1.0\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, '/usr/local/bin/agent');
  assert.deepEqual(calls[0]?.args, ['--help']);
});
