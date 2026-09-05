import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { buildPowerShellCommand } from '../executable.js';

// muse serve는 initialize 응답 뒤 initialized 알림을 받아야 model/list를 허용한다.
export const executeMuseCodeModelList = (
  executable: string,
  options: { spawn?: typeof spawn; platform?: () => NodeJS.Platform; timeoutMs?: number; maxBufferBytes?: number } = {},
): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) => {
    const spawnProcess = options.spawn ?? spawn;
    const isWindows = (options.platform?.() ?? process.platform) === 'win32';
    const child = isWindows
      ? spawnProcess(
          'powershell.exe',
          ['-NoLogo', '-NonInteractive', '-Command', buildPowerShellCommand(executable, ['serve'])],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      : spawnProcess(executable, ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let initialized = false;
    let buffer = '';
    let bytes = 0;
    const decoder = new StringDecoder('utf8');
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve({ stdout: JSON.stringify(result) });
    };
    const timer = setTimeout(
      () => finish(new Error('Muse Code model enumeration timed out')),
      options.timeoutMs ?? 30_000,
    );
    const send = (frame: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stderr.resume();
    child.on('close', (code) => finish(new Error(`Muse Code MSP closed before model/list (exit ${code})`)));
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.maxBufferBytes ?? 10 * 1024 * 1024)) {
        finish(new Error('Muse Code MSP output exceeded buffer limit'));
        return;
      }
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as {
            id?: number;
            error?: { code?: number; message?: string };
            result?: unknown;
          };
          if (frame.id !== 1 && frame.id !== 2) continue;
          if (frame.error) {
            finish(new Error(`Muse Code MSP ${frame.error.code}: ${frame.error.message}`));
            return;
          }
          if (!('result' in frame)) {
            finish(new Error('Muse Code MSP response missing result'));
            return;
          }
          if (frame.id === 1 && !initialized) {
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'model/list', params: {} });
          } else if (frame.id === 2) {
            if (!initialized) {
              finish(new Error('Muse Code MSP model/list arrived before initialize'));
              return;
            }
            finish(undefined, frame.result);
          }
        } catch {
          finish(new Error('Muse Code MSP returned invalid JSON'));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentteams', version: '0.0.1' } } });
  });
