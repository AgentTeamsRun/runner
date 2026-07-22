import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 발견 worktree의 localKey ↔ canonical 로컬 경로 매핑을 runner-side에 원자적으로 저장한다.
 *
 * - 서버 payload에는 절대 경로를 노출하지 않으므로(민감 경로 제외), 실행 시 localKey로 경로를 되찾기 위한 로컬 캐시다.
 * - 쓰기는 temp write + rename으로 원자화한다(부분 기록 방지). auth-path-store와 같은 store 위치 규약을 따른다.
 */
type DiscoveredWorktreeStore = {
  mappings: Record<string, string>;
};

export const getDiscoveredWorktreeStorePath = (): string => join(homedir(), '.agentteams', 'discovered-worktrees.json');

export const loadDiscoveredWorktreeMappings = (
  filePath: string = getDiscoveredWorktreeStorePath(),
): Record<string, string> => {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as DiscoveredWorktreeStore;
    if (parsed && typeof parsed === 'object' && parsed.mappings && typeof parsed.mappings === 'object') {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.mappings)) {
        if (typeof key === 'string' && typeof value === 'string' && key.length > 0 && value.length > 0) {
          result[key] = value;
        }
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
};

export const saveDiscoveredWorktreeMappings = (
  mappings: Record<string, string>,
  filePath: string = getDiscoveredWorktreeStorePath(),
): string => {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ mappings }, null, 2), 'utf8');
  renameSync(tempPath, filePath);
  return filePath;
};

/** 저장된 매핑에서 localKey에 해당하는 canonical 경로를 조회한다. */
export const resolveDiscoveredWorktreePath = (
  localKey: string,
  filePath: string = getDiscoveredWorktreeStorePath(),
): string | null => {
  const mappings = loadDiscoveredWorktreeMappings(filePath);
  return mappings[localKey] ?? null;
};
