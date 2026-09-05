import type { ParseOptions, ParsedLogEntry } from './stream-json-parser.js';

// muse 1.0.2의 MSP v1 봉투와 echo·tool 실측(2026-09-05)을 기준으로 한다.
// `run.output.delta`는 토큰 단위 조각이라 그대로 방출하면 단어 중간에서 끊긴 행이 쌓인다.
// 커서 파서처럼 문단·문장 경계나 길이 상한에서만 TEXT 엔트리로 합쳐 내보낸다.
const TEXT_LOG_MAX = 800;
// 최종 텍스트 폴백 누적 상한(다른 러너의 OUTPUT_CAPTURE_MAX와 동일).
const STREAMED_TEXT_MAX = 200_000;

type MuseTaskLifecycleEvent = { kind?: unknown; task_kind?: unknown; task_id?: unknown };

type MuseEnvelope = {
  schema_version?: number;
  payload_type?: string;
  payload?: { text?: unknown; reason?: unknown; event?: MuseTaskLifecycleEvent };
};

const findTextFlushIndex = (text: string): number => {
  const newlineIndex = text.search(/\r?\n/u);
  if (newlineIndex >= 0) {
    return newlineIndex + (text[newlineIndex] === '\r' ? 2 : 1);
  }

  const sentence = /[.!?。](?:\s|$)/u.exec(text);
  if (sentence?.index !== undefined) {
    return sentence.index + sentence[0].length;
  }

  return text.length >= TEXT_LOG_MAX ? TEXT_LOG_MAX : -1;
};

const normalizeText = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const isVerboseEnabled = (options?: ParseOptions): boolean =>
  typeof options?.verbose === 'boolean' ? options.verbose : process.env.AGENTTEAMS_RUNNER_VERBOSE === '1';

/**
 * Muse Code `exec --json` NDJSON을 사람이 읽을 수 있는 로그 엔트리, 최종 답변, 스트림 실패 사유로
 * 정제한다. 매핑되지 않은 MSP 봉투(태스크 lifecycle 메타데이터 등)는 기본적으로 버리고
 * `AGENTTEAMS_RUNNER_VERBOSE=1`에서만 원문을 SYSTEM으로 남긴다. 도구 태스크는 lifecycle에서
 * 도구 이름만 요약해 TOOL 엔트리로 방출한다.
 */
export const createMuseCodeStreamConsumer = (emit: (entries: ParsedLogEntry[]) => void, options?: ParseOptions) => {
  const verbose = isVerboseEnabled(options);
  let buffer = '';
  let pendingText = '';
  // 마지막 도구 호출 이후 흘러온 델타 전체. 종단 텍스트와 대조해 최종 답변 행의 중복 방출을 막는다.
  let turnText = '';
  let streamedText = '';
  let finalText: string | null = null;
  let failureMessage: string | null = null;
  const toolKindByTaskId = new Map<string, string>();

  const log = (message: string, category: ParsedLogEntry['category'] = 'SYSTEM', toolName?: string) => {
    emit([{ message, category, level: 'INFO', ...(toolName ? { toolName } : {}) }]);
  };
  const logRaw = (line: string) => {
    if (verbose) log(line);
  };

  const flushText = (force = false): void => {
    while (pendingText.length > 0) {
      const flushIndex = force ? Math.min(pendingText.length, TEXT_LOG_MAX) : findTextFlushIndex(pendingText);
      if (flushIndex < 0) return;

      const message = normalizeText(pendingText.slice(0, flushIndex));
      pendingText = pendingText.slice(flushIndex);
      if (message.length > 0) log(message, 'TEXT');
      if (!force && pendingText.length < TEXT_LOG_MAX && findTextFlushIndex(pendingText) < 0) return;
    }
  };

  const appendStreamedText = (text: string): void => {
    if (streamedText.length >= STREAMED_TEXT_MAX) return;
    streamedText += text.slice(0, STREAMED_TEXT_MAX - streamedText.length);
  };

  // 도구 태스크(task_kind `tool.*`)는 proposed에서 이름을 기억해 두고, started/completed에서
  // 상태를 붙여 TOOL로 방출한다. 모델 응답 태스크(`model.*`)는 진행 상황이 아니므로 버린다.
  const consumeTaskLifecycle = (payloadType: string, event: MuseTaskLifecycleEvent | undefined, line: string) => {
    const taskId = typeof event?.task_id === 'string' ? event.task_id : '';
    const stage = payloadType.slice('task.lifecycle.'.length);
    if (stage === 'proposed') {
      const taskKind = typeof event?.task_kind === 'string' ? event.task_kind : '';
      if (taskKind.startsWith('tool.') && taskId) {
        toolKindByTaskId.set(taskId, taskKind);
        flushText(true);
        turnText = '';
        log(`[Tool] ${taskKind} (proposed)`, 'TOOL', taskKind);
        return;
      }
      logRaw(line);
      return;
    }
    const toolKind = taskId ? toolKindByTaskId.get(taskId) : undefined;
    if (!toolKind) {
      logRaw(line);
      return;
    }
    if (stage === 'started' || stage === 'completed' || stage === 'failed') {
      log(`[Tool] ${toolKind} (${stage})`, 'TOOL', toolKind);
      if (stage !== 'started') toolKindByTaskId.delete(taskId);
      return;
    }
    logRaw(line);
  };

  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: MuseEnvelope;
    try {
      event = JSON.parse(line) as MuseEnvelope;
    } catch {
      logRaw(line);
      return;
    }
    const payload = event?.payload;
    if (event?.schema_version !== 1 || !payload || typeof payload !== 'object') {
      logRaw(line);
      return;
    }
    const payloadType = event.payload_type ?? '';
    if (payloadType.startsWith('task.lifecycle.')) {
      consumeTaskLifecycle(payloadType, payload.event, line);
      return;
    }
    switch (payloadType) {
      case 'run.output.delta':
        if (typeof payload.text !== 'string') {
          logRaw(line);
          return;
        }
        appendStreamedText(payload.text);
        pendingText += payload.text;
        turnText += payload.text;
        flushText();
        return;
      case 'run.terminal.completed':
        if (typeof payload.text !== 'string') {
          logRaw(line);
          return;
        }
        finalText = payload.text;
        // 델타가 최종 답변과 일치하면 남은 조각을 경계 있는 행으로 마저 내보내 답변을 완성한다.
        // 다르면(스트림 누락 등) 조각을 폐기하고 완성된 최종 답변을 한 행으로 남긴다.
        if (normalizeText(turnText) === normalizeText(finalText)) {
          flushText(true);
        } else {
          pendingText = '';
          if (finalText.trim().length > 0) log(normalizeText(finalText), 'TEXT');
        }
        return;
      case 'run.terminal.failed':
        flushText(true);
        failureMessage = typeof payload.reason === 'string' && payload.reason ? payload.reason : 'Muse Code run failed';
        log(failureMessage, 'SYSTEM');
        return;
      default:
        logRaw(line);
    }
  };
  return {
    push(text: string) {
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    flush() {
      consume(buffer);
      buffer = '';
      flushText(true);
    },
    getFinalText: () => finalText,
    getStreamedTextFallback: () => streamedText || null,
    getFailureMessage: () => failureMessage,
  };
};
