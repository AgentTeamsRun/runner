const MAX_MESSAGE_LENGTH = 2000;

export type MergeableRunnerLog = {
  level: 'INFO' | 'WARN' | 'ERROR';
  category?: 'SYSTEM' | 'TEXT' | 'THINKING' | 'TOOL' | 'RESULT' | 'STDERR';
  toolName?: string;
  message: string;
};

// TOOL 로그는 도구 호출 1건이 저장 행 1건이어야 한다. 웹의 `groupAdjacentLogs`가 인접한
// 저장 행의 `level/category/toolName`을 비교해 `<tool> ×N` 그룹을 만들기 때문에, 여기서
// 여러 호출을 한 행으로 합치면 그룹이 만들어지지 않고 첫 호출의 `toolName`만 남아
// 서로 다른 도구까지 첫 도구명으로 표시된다.
const isMergeableCategory = (category: string | null | undefined): boolean => category !== 'TOOL';

/** Runner와 Web의 로그 그룹핑 계약에서 함께 검증하는 무의존 순수 함수. */
export const mergeLogs = (logs: MergeableRunnerLog[]): MergeableRunnerLog[] => {
  if (logs.length === 0) {
    return [];
  }

  const merged: MergeableRunnerLog[] = [];
  let current = { ...logs[0] } as MergeableRunnerLog;

  for (let index = 1; index < logs.length; index += 1) {
    const log = logs[index];
    if (!log) continue;
    const combined = `${current.message}\n${log.message}`;
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
