import type {
  ClaimResult,
  DaemonInfo,
  DaemonTrigger,
  OsType,
  TriggerFinalStatus,
  TriggerLogInput,
  TriggerRuntime
} from "./types.js";
import { logger } from "./logger.js";

const MAX_NETWORK_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNetworkError = (error: unknown): boolean => {
  return error instanceof Error;
};

const detectOsType = (): OsType | undefined => {
  if (process.platform === "darwin") {
    return "MACOS";
  }

  if (process.platform === "linux") {
    return "LINUX";
  }

  if (process.platform === "win32") {
    return "WINDOWS";
  }

  return undefined;
};

export class DaemonApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly daemonToken: string
  ) {}

  private daemonHeaders(options?: { includeOsType?: boolean }): Record<string, string> {
    const headers: Record<string, string> = {
      "x-daemon-token": this.daemonToken
    };

    if (options?.includeOsType) {
      const osType = detectOsType();
      if (osType) {
        headers["x-os-type"] = osType;
      }
    }

    return headers;
  }

  private async requestWithRetry(path: string, options: RequestInit): Promise<Response> {
    const url = `${this.apiUrl}${path}`;

    for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt += 1) {
      try {
        return await fetch(url, options);
      } catch (error) {
        if (!isNetworkError(error) || attempt >= MAX_NETWORK_RETRIES) {
          throw error;
        }

        const retryNumber = attempt + 1;
        const delayMs = BASE_BACKOFF_MS * (2 ** attempt);
        logger.warn(`Retry ${retryNumber}/${MAX_NETWORK_RETRIES}: network error while requesting daemon API`, {
          path,
          delayMs,
          error: error instanceof Error ? error.message : String(error)
        });
        await wait(delayMs);
      }
    }

    throw new Error("Unexpected retry loop exit");
  }

  async validateDaemonToken(): Promise<DaemonInfo> {
    const response = await this.requestWithRetry("/api/daemons/me", {
      method: "GET",
      headers: this.daemonHeaders({ includeOsType: true })
    });

    if (!response.ok) {
      throw new Error(`Daemon token validation failed (${response.status})`);
    }

    const payload = await response.json() as { data: DaemonInfo };
    return payload.data;
  }

  async fetchPendingTrigger(): Promise<DaemonTrigger | null> {
    const response = await this.requestWithRetry("/api/daemon-triggers/pending", {
      method: "GET",
      headers: this.daemonHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch pending trigger (${response.status})`);
    }

    const payload = await response.json() as { data: DaemonTrigger | null };
    return payload.data;
  }

  async claimTrigger(triggerId: string): Promise<ClaimResult> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/claim`, {
      method: "PATCH",
      headers: this.daemonHeaders()
    });

    if (response.status === 409) {
      return { ok: false, conflict: true };
    }

    if (!response.ok) {
      throw new Error(`Failed to claim trigger (${response.status})`);
    }

    return { ok: true, conflict: false };
  }

  async updateTriggerStatus(
    triggerId: string,
    status: TriggerFinalStatus,
    errorMessage?: string
  ): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/status`, {
      method: "PATCH",
      headers: {
        ...this.daemonHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        status,
        ...(errorMessage ? { errorMessage } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to update trigger status (${response.status})`);
    }
  }

  async updateTriggerHistory(
    triggerId: string,
    historyMarkdown: string
  ): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/history`, {
      method: "PATCH",
      headers: {
        ...this.daemonHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        historyMarkdown
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to update trigger history (${response.status})`);
    }
  }

  async fetchOrphanedCancelRequested(): Promise<string[]> {
    const response = await this.requestWithRetry("/api/daemon-triggers/orphaned-cancel-requested", {
      method: "GET",
      headers: this.daemonHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch orphaned cancel-requested triggers (${response.status})`);
    }

    const payload = await response.json() as { data: string[] };
    return payload.data;
  }

  async isTriggerCancelRequested(triggerId: string): Promise<boolean> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/cancel-status/${triggerId}`, {
      method: "GET",
      headers: this.daemonHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trigger cancel status (${response.status})`);
    }

    const payload = await response.json() as { data: { cancelRequested: boolean } };
    return payload.data.cancelRequested;
  }

  async fetchTriggerRuntime(triggerId: string): Promise<TriggerRuntime> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/runtime`, {
      method: "GET",
      headers: this.daemonHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trigger runtime (${response.status})`);
    }

    const payload = await response.json() as { data: TriggerRuntime };
    return payload.data;
  }

  async appendTriggerLogs(triggerId: string, input: { logs?: TriggerLogInput[]; heartbeat?: boolean }): Promise<void> {
    const response = await this.requestWithRetry(`/api/daemon-triggers/${triggerId}/logs`, {
      method: "POST",
      headers: {
        ...this.daemonHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      throw new Error(`Failed to append trigger logs (${response.status})`);
    }
  }
}
