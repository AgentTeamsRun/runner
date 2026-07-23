import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPowerShellCommand, resolveExecutablePath, resolveExecutablePathWithPreference } from './executable.js';

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
  const kimiPath = '/Users/justin/.kimi-code/bin/kimi';
  const resolved = resolveExecutablePath('kimi', {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'darwin',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) => path === kimiPath) as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, kimiPath);
});

test('resolveExecutablePath falls back to the Kimi install bin on Windows', () => {
  const kimiPath = 'C:\\Users\\justin/.kimi-code/bin/kimi.cmd';
  const resolved = resolveExecutablePath('kimi', {
    env: {
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\justin',
    },
    platform: () => 'win32',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) => path === kimiPath) as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, kimiPath);
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

test('resolveExecutablePathWithPreference falls back to the Kimi install bin', () => {
  const kimiPath = '/Users/justin/.kimi-code/bin/kimi';
  const resolved = resolveExecutablePathWithPreference('kimi', ['kimi'], {
    env: {
      HOME: '/Users/justin',
    },
    platform: () => 'linux',
    execFileSync: (() => {
      throw new Error('not found');
    }) as unknown as typeof import('node:child_process').execFileSync,
    existsSync: ((path: string) => path === kimiPath) as typeof import('node:fs').existsSync,
  });

  assert.equal(resolved, kimiPath);
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
