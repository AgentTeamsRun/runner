import { logger } from '../logger.js';
import { DaemonApiClient } from '../api-client.js';
import type { TriggerLogCategory, TriggerLogInput, TriggerLogLevel } from '../types.js';

const MAX_BATCH_SIZE = 50;
const MAX_BUFFERED_LOGS = 500;
const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// TOOL 로그는 도구 호출 1건이 저장 행 1건이어야 한다. 웹의 `groupAdjacentLogs`가 인접한
// 저장 행의 `level/category/toolName`을 비교해 `<tool> ×N` 그룹을 만들기 때문에, 여기서
// 여러 호출을 한 행으로 합치면 그룹이 만들어지지 않고 첫 호출의 `toolName`만 남아
// 서로 다른 도구까지 첫 도구명으로 표시된다. 그래서 병합 키에 `toolName`을 더하는 대신
// TOOL 카테고리 자체를 병합 대상에서 제외한다(같은 도구 반복 호출도 ×N으로 보이게).
const isMergeableCategory = (category: TriggerLogInput['category']): boolean => category !== 'TOOL';

export const mergeLogs = (logs: TriggerLogInput[]): TriggerLogInput[] => {
  if (logs.length === 0) {
    return [];
  }

  const merged: TriggerLogInput[] = [];
  let current = { ...logs[0] };

  for (let i = 1; i < logs.length; i++) {
    const log = logs[i];
    const combined = current.message + '\n' + log.message;
    if (
      log.level === current.level &&
      log.category === current.category &&
      isMergeableCategory(log.category) &&
      combined.length <= MAX_MESSAGE_LENGTH
    ) {
      current.message = combined;
    } else {
      merged.push(current);
      current = { ...log };
    }
  }

  merged.push(current);
  return merged;
};

const normalizeMessage = (message: string): string => {
  const withoutAnsi = message.replace(ANSI_ESCAPE_PATTERN, '');
  const normalizedNewline = withoutAnsi.replace(/\r\n?/g, '\n');
  const withoutControlChars = normalizedNewline.replace(CONTROL_CHAR_PATTERN, '');
  const squashed = withoutControlChars.replace(/\n{3,}/g, '\n\n');
  const trimmed = squashed.trim();
  if (trimmed.length <= MAX_MESSAGE_LENGTH) {
    return trimmed;
  }

  return trimmed.slice(0, MAX_MESSAGE_LENGTH);
};

export class TriggerLogReporter {
  private readonly queue: TriggerLogInput[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight = false;
  private droppedCount = 0;

  constructor(
    private readonly client: DaemonApiClient,
    private readonly triggerId: string,
    private readonly flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      void this.flush({ heartbeat: true });
    }, this.flushIntervalMs);
  }

  append(level: TriggerLogLevel, message: string, category?: TriggerLogCategory, toolName?: string): void {
    const normalized = normalizeMessage(message);
    if (normalized.length === 0) {
      return;
    }

    if (this.queue.length >= MAX_BUFFERED_LOGS) {
      this.queue.shift();
      this.droppedCount += 1;
    }

    this.queue.push({
      level,
      message: normalized,
      ...(category ? { category } : {}),
      ...(toolName ? { toolName } : {}),
    });
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush({ heartbeat: true, drain: true });
  }

  private async flush(opts: { heartbeat: boolean; drain?: boolean }): Promise<void> {
    if (this.flushInFlight) {
      return;
    }

    this.flushInFlight = true;

    try {
      if (this.droppedCount > 0) {
        const droppedMessage = `Dropped ${this.droppedCount} log line(s) due to buffer limit (${MAX_BUFFERED_LOGS}).`;
        this.queue.unshift({ level: 'WARN', message: droppedMessage });
        this.droppedCount = 0;
      }

      if (opts.drain) {
        while (this.queue.length > 0) {
          const batch = mergeLogs(this.queue.splice(0, MAX_BATCH_SIZE));
          await this.send({ logs: batch, heartbeat: opts.heartbeat });
          opts.heartbeat = false;
        }

        if (opts.heartbeat) {
          await this.send({ heartbeat: true });
        }

        return;
      }

      const batch = mergeLogs(this.queue.splice(0, MAX_BATCH_SIZE));
      if (batch.length === 0 && !opts.heartbeat) {
        return;
      }

      await this.send({ logs: batch.length > 0 ? batch : undefined, heartbeat: opts.heartbeat });
    } finally {
      this.flushInFlight = false;
    }
  }

  private async send(payload: { logs?: TriggerLogInput[]; heartbeat?: boolean }): Promise<void> {
    if (!payload.logs && !payload.heartbeat) {
      return;
    }

    try {
      await this.client.appendTriggerLogs(this.triggerId, payload);
    } catch (error) {
      logger.warn('Failed to report trigger logs', {
        triggerId: this.triggerId,
        error: error instanceof Error ? error.message : String(error),
        payloadSize: payload.logs?.length ?? 0,
        heartbeat: payload.heartbeat === true,
      });
    }
  }
}
