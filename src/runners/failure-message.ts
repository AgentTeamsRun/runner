type FailureMessageOptions = {
  exitCode: number | null;
  lastErrorOutput: string;
  lastOutput: string;
};

export const selectRunnerFailureMessage = ({
  exitCode,
  lastErrorOutput,
  lastOutput,
}: FailureMessageOptions): string | undefined => {
  if (exitCode === 0) return undefined;

  const errorOutput = lastErrorOutput.trim();
  if (errorOutput.length > 0) return errorOutput;

  const output = lastOutput.trim();
  if (output.length > 0) return output;

  return `Runner exited with code ${exitCode ?? 1}`;
};

/// 러너가 남긴 마지막 실패 사유 후보들. 트리거 핸들러가 조립한다.
type PreferredFailureMessageOptions = {
  /// 구조화 로그 파서가 만든 RESULT 카테고리 메시지 중 마지막 값(원문 그대로).
  resultFailureDetail?: string | null;
  /// 러너가 RunResult.errorMessage로 돌려준 값(대개 stderr 마지막 줄).
  runnerErrorMessage?: string | null;
  lastOutput?: string | null;
  exitCode: number | null;
  idleTimedOut?: boolean;
  /// 워치독(idle 또는 fail-safe)에 걸려 종료됐는지. idle만 참일 때도 이 값은 참이다.
  timedOut?: boolean;
};

/// 실패를 알리는 RESULT 메시지의 머리말. 이 뒤에 실제 사유가 붙어야만 채택 대상이 된다.
const RESULT_FAILURE_HEADS = ['[Result] Failed', '[Result] Error'] as const;

/// RESULT 메시지가 "원인을 담고 있는지" 판정한다.
///
/// 파서마다 실패 마커를 만드는 방식이 다르다.
/// - 원인 있음: `[Result] Failed: <detail>`(codex), `[Result] Error after 12s (3 turns): <detail>`(claude 계열)
/// - 원인 없음: `[Result] Failed`, `[Result] Failed in 12s`, `[Result] Failed (12s, 3 files changed)`(copilot 등)
///
/// 머리말 뒤에 콜론이 있고 그 뒤 문자열이 비어 있지 않을 때만 원인으로 인정한다. 소요 시간·변경
/// 파일 수 같은 요약만 붙은 마커를 사유로 승격하면 오히려 stderr의 실제 오류를 가린다.
export const isCauseBearingResultMessage = (message: string): boolean => {
  const trimmed = message.trim();
  const head = RESULT_FAILURE_HEADS.find((candidate) => trimmed.startsWith(candidate));
  if (!head) return false;

  const separatorIndex = trimmed.indexOf(':', head.length);
  if (separatorIndex === -1) return false;

  return trimmed.slice(separatorIndex + 1).trim().length > 0;
};

/// 트리거를 FAILED로 보고할 때 사용자에게 보여줄 사유를 고른다.
///
/// 우선순위
/// 1. 워치독(idle·fail-safe)에 걸렸으면 러너가 만든 문구를 그대로 쓴다 — 타임아웃 사실이 사유보다
///    중요하다. 프로세스가 걸리기 전에 원인 있는 RESULT를 한 번 냈더라도, 그 줄을 사유로 올리면
///    몇 시간 매달리다 강제 종료된 실행이 "러너가 스스로 보고한 실패"로 보여 조치가 어긋난다.
/// 2. 원인이 담긴 RESULT 메시지(구조화 로그에서 파싱한 원문).
/// 3. 러너의 errorMessage(대개 stderr 마지막 줄).
/// 4. 마지막 일반 출력.
/// 5. 종료 코드.
export const selectPreferredFailureMessage = ({
  resultFailureDetail,
  runnerErrorMessage,
  lastOutput,
  exitCode,
  idleTimedOut,
  timedOut,
}: PreferredFailureMessageOptions): string => {
  const watchdogTimedOut = idleTimedOut === true || timedOut === true;
  const runnerError = runnerErrorMessage?.trim() ?? '';
  if (watchdogTimedOut && runnerError.length > 0) return runnerError;

  const resultDetail = resultFailureDetail?.trim() ?? '';
  if (!watchdogTimedOut && resultDetail.length > 0 && isCauseBearingResultMessage(resultDetail)) {
    return resultDetail;
  }

  if (runnerError.length > 0) return runnerError;

  const output = lastOutput?.trim() ?? '';
  if (output.length > 0) return output;

  return `Runner exited with code ${exitCode ?? 1}`;
};
