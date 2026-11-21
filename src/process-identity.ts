import { execFileSync } from 'node:child_process';
import { platform as getPlatform } from 'node:os';
import { win32 as winPath } from 'node:path';

type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; windowsHide: boolean; timeout: number; stdio: ['ignore', 'pipe', 'ignore'] },
) => string | Buffer;

export type ProcessStartTimeDeps = {
  platform?: () => NodeJS.Platform;
  execFileSync?: ExecFileSyncFn;
};

// The query is a single short-lived probe on a termination path, so a hung
// shell must never block a restart longer than the restart's own budget.
const startTimeProbeTimeoutMs = 5_000;

// Resolved absolutely for the same reason the autostart chain does it: an
// unqualified `powershell.exe` is subject to the application/current directory
// search order.
const getWindowsPowerShellPath = (): string =>
  winPath.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const parseDate = (value: string): Date | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// A globally installed runner is `node …\node_modules\@agentteams\runner\dist\index.js start`
// behind the `agentrunner` shim; a source checkout runs `daemon\dist\index.js`.
const AGENT_RUNNER_COMMAND_LINE = /agentrunner|@agentteams[\\/]runner[\\/]|[\\/]daemon[\\/]dist[\\/]index\.js/iu;

/**
 * Whether a live Windows process is an AgentRunner, judged by its command line.
 * This is the fallback identity check for a PID record that carries no start
 * time to compare (a runner that predates instance identity): without it, a
 * forced stop would have to trust a bare PID that Windows may have reused.
 * False whenever the command line cannot be read — unknown is not confirmed.
 */
export const isAgentRunnerProcess = (pid: number, deps: ProcessStartTimeDeps = {}): boolean => {
  const run = (deps.execFileSync ?? execFileSync) as ExecFileSyncFn;

  try {
    const output = run(
      getWindowsPowerShellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
          `if ($p) { $p.CommandLine }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: startTimeProbeTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return AGENT_RUNNER_COMMAND_LINE.test(String(output));
  } catch {
    return false;
  }
};

/**
 * The OS-reported creation time of a live process, or null when it cannot be
 * read. Callers must treat null as "unverifiable" rather than "mismatch": a
 * platform or environment we cannot probe has to keep behaving the way it did
 * before this check existed.
 */
export const readProcessStartTime = (pid: number, deps: ProcessStartTimeDeps = {}): Date | null => {
  const resolvedPlatform = (deps.platform ?? getPlatform)();
  const run = (deps.execFileSync ?? execFileSync) as ExecFileSyncFn;

  try {
    if (resolvedPlatform === 'win32') {
      const output = run(
        getWindowsPowerShellPath(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
            `if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: startTimeProbeTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return parseDate(String(output));
    }

    // `lstart` is the one start-time column POSIX `ps` prints unabbreviated, so
    // it survives long-running processes that `stime` would render as a date.
    const output = run('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: startTimeProbeTimeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseDate(String(output));
  } catch {
    return null;
  }
};
