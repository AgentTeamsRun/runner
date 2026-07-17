import { createRequire } from 'node:module';
import type {
  ClaimResult,
  DaemonInfo,
  InjectedConventionRecord,
  OsType,
  PollStateResponse,
  TriggerFinalStatus,
  TriggerLogInput,
  TriggerRuntime,
} from './types.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };
const runnerVersion = packageJson.version ?? '0.0.0';

const MAX_NETWORK_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
export const DAEMON_API_TRANSPORT_TIMEOUT_MS = 30_000;

class DaemonApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Daemon API request timed out after ${timeoutMs}ms`);
    this.name = 'DaemonApiTimeoutError';
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNetworkError = (error: unknown): boolean => {
  return error instanceof Error;
};

const detectOsType = (): OsType | undefined => {
  if (process.platform === 'darwin') {
    return 'MACOS';
  }

  if (process.platform === 'linux') {
    return 'LINUX';
  }

  if (process.platform === 'win32') {
    return 'WINDOWS';
  }

  return undefined;
};

export class DaemonApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly daemonToken: string,
  ) {}

  private daemonHeaders(options?: { includeOsType?: boolean }): Record<string, string> {
    const headers: Record<string, string> = {
      'X-AgentTeams-Client': 'daemon',
      'x-daemon-token': this.daemonToken,
      'x-runner-version': runnerVersion,
    };

    if (options?.includeOsType) {
      const osType = detectOsType();
      if (osType) {
        headers['x-os-type'] = osType;
      }
    }

    return headers;
  }

  private async requestWithRetry(path: string, options: Omit<RequestInit, 'signal'>): Promise<Response> {
    const url = `${this.apiUrl}${path}`;

    for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt += 1) {
      const timeoutController = new AbortController();
      const timeoutError = new DaemonApiTimeoutError(DAEMON_API_TRANSPORT_TIMEOUT_MS);
      const timeoutHandle = setTimeout(() => {
        timeoutController.abort(timeoutError);
      }, DAEMON_API_TRANSPORT_TIMEOUT_MS);

      try {
        return await fetch(url, { ...options, signal: timeoutController.signal });
      } catch (error) {
        if (!isNetworkError(error) || attempt >= MAX_NETWORK_RETRIES) {
          throw error;
        }

        const retryNumber = attempt + 1;
        const delayMs = BASE_BACKOFF_MS * 2 ** attempt;
        logger.warn(`Retry ${retryNumber}/${MAX_NETWORK_RETRIES}: network error while requesting daemon API`, {
          path,
          retryNumber,
          delayMs,
          ...(error instanceof DaemonApiTimeoutError ? { timeoutMs: error.timeoutMs } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
        await wait(delayMs);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new Error('Unexpected retry loop exit');
  }

  async validateDaemonToken(): Promise<DaemonInfo> {
    const response = await this.requestWithRetry('/api/daemons/me', {
      method: 'GET',
      headers: this.daemonHeaders({ includeOsType: true }),
    });

    if (!response.ok) {
      throw new Error(`Daemon token validation failed (${response.status})`);
    }

    const payload = (await response.json()) as { data: DaemonInfo };
    return payload.data;
  }

  // 한 polling cycle에 필요한 세 read(고아 취소 대상 / 워크트리 제거 대상 / pending)를
  // 통합 snapshot 엔드포인트로 한 번에 조회한다. 실패 시 명확한 에러를 던져 호출자가
  // polling cycle을 실패 처리하도록 한다(조용히 생략하지 않는다).
  async fetchPollState(): Promise<PollStateResponse> {
    const response = await this.requestWithRetry('/api/daemon-triggers/poll-state', {
      method: 'GET',
      headers: this.daemonHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch poll state (${response.status})`);
    }

    const payload = (await response.json()) as PollStateResponse;
    return payload;
  }

  async claimTrigger(triggerId: string): Promise<ClaimResult> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/claim`, {
      method: 'PATCH',
      headers: this.daemonHeaders(),
    });

    if (response.status === 409) {
      return { ok: false, conflict: true };
    }

    if (!response.ok) {
      throw new Error(`Failed to claim trigger (${response.status})`);
    }

    return { ok: true, conflict: false };
  }

  async updateTriggerStatus(triggerId: string, status: TriggerFinalStatus, errorMessage?: string): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/status`, {
      method: 'PATCH',
      headers: {
        ...this.daemonHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status,
        ...(errorMessage ? { errorMessage } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update trigger status (${response.status})`);
    }
  }

  async updateTriggerHistory(triggerId: string, historyMarkdown: string): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/history`, {
      method: 'PATCH',
      headers: {
        ...this.daemonHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        historyMarkdown,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update trigger history (${response.status})`);
    }
  }

  async isTriggerCancelRequested(triggerId: string): Promise<boolean> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/cancel-status/${triggerId}`, {
      method: 'GET',
      headers: this.daemonHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trigger cancel status (${response.status})`);
    }

    const payload = (await response.json()) as { data: { cancelRequested: boolean } };
    return payload.data.cancelRequested;
  }

  async fetchTriggerRuntime(triggerId: string): Promise<TriggerRuntime> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/runtime`, {
      method: 'GET',
      headers: this.daemonHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trigger runtime (${response.status})`);
    }

    const payload = (await response.json()) as { data: TriggerRuntime };
    return payload.data;
  }

  async reportWorktreeStatus(triggerId: string, status: string, worktreeError?: string): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/worktree/status`, {
      method: 'PATCH',
      headers: {
        ...this.daemonHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        worktreeStatus: status,
        ...(worktreeError ? { worktreeError } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to report worktree status (${response.status})`);
    }
  }

  async appendTriggerLogs(triggerId: string, input: { logs?: TriggerLogInput[]; heartbeat?: boolean }): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/logs`, {
      method: 'POST',
      headers: {
        ...this.daemonHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`Failed to append trigger logs (${response.status})`);
    }
  }

  async recordInjectedConventions(triggerId: string, items: InjectedConventionRecord[]): Promise<void> {
    if (items.length === 0) return;

    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/conventions`, {
      method: 'POST',
      headers: {
        ...this.daemonHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items }),
    });

    if (!response.ok) {
      throw new Error(`Failed to record injected conventions (${response.status})`);
    }
  }

  async ackRestartRequest(): Promise<void> {
    const response = await this.requestWithRetry('/api/daemons/restart-ack', {
      method: 'POST',
      headers: this.daemonHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to ack restart request (${response.status})`);
    }
  }

  async notifyUpdate(version: string, pkg: 'cli' | 'runner' = 'runner'): Promise<void> {
    const response = await this.requestWithRetry('/api/daemons/notify-update', {
      method: 'POST',
      headers: {
        ...this.daemonHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version, package: pkg }),
    });

    if (!response.ok) {
      throw new Error(`Failed to notify update (${response.status})`);
    }
  }
}
