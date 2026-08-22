/**
 * `npm install -g` 실패 원인 분류의 단일 출처(SSOT).
 *
 * 수동 업데이트(`agentrunner update`)와 자동 업데이트가 같은 판정을 쓰도록 여기로 추출했다.
 * 자동 업데이트는 이 분류 결과를 서버에도 보고하므로, 문구가 아니라 `reason` 코드가 계약이다.
 */
export type InstallFailureReason = 'PERMISSION_DENIED' | 'UNKNOWN';

const PERMISSION_DENIED_MESSAGE =
  'Global npm install requires elevated permissions. Configure a user-level npm prefix or rerun the update with appropriate permissions.';

const BIN_CONFLICT_MESSAGE =
  'Global npm install failed because a command name is already taken by a file from another source. ' +
  'npm prints the conflicting path after "File exists:" — remove or rename that file, then retry the update.';

const toMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isPermissionFailure = (message: string): boolean =>
  message.includes('EACCES') || message.includes('EPERM') || message.toLowerCase().includes('permission denied');

/**
 * 전역 bin 이름 충돌. 패키지가 링크하려는 bin 이름을 다른 출처의 파일이 이미 점유하고 있으면
 * npm은 `EEXIST` / `File exists:`로 설치 전체를 실패시킨다. 사용자가 그 파일을 치우기 전에는 풀리지 않는다.
 */
const isBinConflictFailure = (message: string): boolean =>
  message.includes('EEXIST') || message.includes('File exists:');

export const classifyInstallError = (error: unknown): InstallFailureReason => {
  if (isPermissionFailure(toMessage(error))) {
    return 'PERMISSION_DENIED';
  }

  return 'UNKNOWN';
};

/**
 * 재시도만으로는 절대 풀리지 않고 사용자가 직접 손대야 하는 실패인지 판정한다.
 *
 * 서버로 보내는 `reason` 코드 계약(`PERMISSION_DENIED` | `UNKNOWN`)은 그대로 두고, 자동 업데이트의
 * 재시도 백오프만 이 판정으로 넓힌다. bin 이름 충돌은 `UNKNOWN`으로 보고되지만 1시간마다 재시도할
 * 이유가 없는 실패라 여기에 포함된다.
 */
export const requiresManualFix = (error: unknown): boolean => {
  const message = toMessage(error);
  return isPermissionFailure(message) || isBinConflictFailure(message);
};

/** 사용자에게 보여줄 설치 실패 메시지. 조치 방법이 정해진 실패는 고정 문구를 쓴다. */
export const describeInstallError = (error: unknown): string => {
  const message = toMessage(error);

  if (isPermissionFailure(message)) {
    return PERMISSION_DENIED_MESSAGE;
  }

  if (isBinConflictFailure(message)) {
    return BIN_CONFLICT_MESSAGE;
  }

  return `Failed to install the latest AgentRunner package: ${message}`;
};

/** 설치 실패를 사용자용 문구로 정규화한 Error로 바꾼다. */
export const normalizeInstallError = (error: unknown): Error => new Error(describeInstallError(error));
