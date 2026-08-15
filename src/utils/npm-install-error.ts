/**
 * `npm install -g` 실패 원인 분류의 단일 출처(SSOT).
 *
 * 수동 업데이트(`agentrunner update`)와 자동 업데이트가 같은 판정을 쓰도록 여기로 추출했다.
 * 자동 업데이트는 이 분류 결과를 서버에도 보고하므로, 문구가 아니라 `reason` 코드가 계약이다.
 */
export type InstallFailureReason = 'PERMISSION_DENIED' | 'UNKNOWN';

const PERMISSION_DENIED_MESSAGE =
  'Global npm install requires elevated permissions. Configure a user-level npm prefix or rerun the update with appropriate permissions.';

export const classifyInstallError = (error: unknown): InstallFailureReason => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('EACCES') || message.includes('EPERM') || message.toLowerCase().includes('permission denied')) {
    return 'PERMISSION_DENIED';
  }

  return 'UNKNOWN';
};

/** 사용자에게 보여줄 설치 실패 메시지. 권한 실패는 조치 방법을 담은 고정 문구를 쓴다. */
export const describeInstallError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);

  if (classifyInstallError(error) === 'PERMISSION_DENIED') {
    return PERMISSION_DENIED_MESSAGE;
  }

  return `Failed to install the latest AgentRunner package: ${message}`;
};

/** 설치 실패를 사용자용 문구로 정규화한 Error로 바꾼다. */
export const normalizeInstallError = (error: unknown): Error => new Error(describeInstallError(error));
