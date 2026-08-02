import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGitRepo } from './git-worktree.js';

/**
 * 러너가 실행 cwd로 쓰는 경로가 "그 머신에 실제로 존재하는 프로젝트"인지 판정한다.
 *
 * 러너는 실행 시작과 동시에 `<cwd>/.agentteams/runner/log`를 `mkdir(recursive)`로 만들기 때문에,
 * 다른 머신에 등록된 에이전트의 authPath를 집어가면 빈 디렉터리를 새로 만들고 그 안에서 실행된다.
 * 판정은 러너 진입 이전 단계에서 수행해야 하며(디렉터리 생성 전), 8종 러너 공통 경로인
 * trigger handler 한 곳에서만 호출한다.
 */
export const PROJECT_MARKER_RELATIVE_PATH = join('.agentteams', 'config.json');

export type WorkingDirectoryCheckDependencies = {
  pathExists?: (path: string) => boolean;
  isGitRepo?: (path: string) => boolean;
  // 마커 파일 읽기. 읽지 못하면 null을 반환한다(판정은 git 저장소 폴백으로 내려간다).
  readProjectMarker?: (path: string) => string | null;
  // 이 트리거가 속한 프로젝트. 없으면 프로젝트 동일성 판정을 건너뛴다(구버전 API 폴백).
  expectedProjectId?: string | null;
};

export type WorkingDirectoryCheckCode =
  | 'MISSING_AUTH_PATH'
  | 'DIRECTORY_NOT_FOUND'
  | 'NOT_A_PROJECT_DIRECTORY'
  | 'PROJECT_MISMATCH';

const defaultReadProjectMarker = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// 마커에서 projectId만 뽑는다. 형식이 깨졌거나 값이 없으면 null(=판정 불가).
const readMarkerProjectId = (raw: string | null): string | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const projectId = (parsed as { projectId?: unknown }).projectId;
    return typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : null;
  } catch {
    return null;
  }
};

export type WorkingDirectoryCheck = { valid: true } | { valid: false; code: WorkingDirectoryCheckCode; reason: string };

const WRONG_MACHINE_HINT =
  'Request the run on the runner installed on the machine where this agent was registered, ' +
  'or re-register the agent on this machine.';

/**
 * 실행 직전 작업 디렉터리 검증. 부수 효과가 없는 순수 판정 함수다(디렉터리를 만들지 않는다).
 */
export function checkRunnerWorkingDirectory(
  authPath: string | null | undefined,
  dependencies: WorkingDirectoryCheckDependencies = {},
): WorkingDirectoryCheck {
  const pathExists = dependencies.pathExists ?? existsSync;
  const checkIsGitRepo = dependencies.isGitRepo ?? isGitRepo;
  const readProjectMarker = dependencies.readProjectMarker ?? defaultReadProjectMarker;
  const expectedProjectId = dependencies.expectedProjectId?.trim() || null;

  const normalizedAuthPath = typeof authPath === 'string' ? authPath.trim() : '';

  if (normalizedAuthPath.length === 0) {
    return {
      valid: false,
      code: 'MISSING_AUTH_PATH',
      reason:
        'Runner workspace path is not configured for this agent; run aborted before start. ' +
        `Set the agent's workspace path first. ${WRONG_MACHINE_HINT}`,
    };
  }

  if (!pathExists(normalizedAuthPath)) {
    return {
      valid: false,
      code: 'DIRECTORY_NOT_FOUND',
      reason:
        `Runner workspace ${normalizedAuthPath} does not exist on this runner, ` +
        `so the run was aborted before start and the directory was not created. ${WRONG_MACHINE_HINT}`,
    };
  }

  const markerPath = join(normalizedAuthPath, PROJECT_MARKER_RELATIVE_PATH);
  const hasProjectMarker = pathExists(markerPath);

  // 마커가 있고 양쪽 projectId를 모두 아는 경우에만 프로젝트 동일성을 판정한다. "존재하는 어떤 git
  // 저장소"라도 통과시키면, 같은 사용자명·같은 디렉터리 배치를 쓰는 흔한 환경에서 다른 머신의
  // 트리거가 무관한 저장소에 그대로 맞아떨어져 이 검증이 없애려던 조용한 오실행이 남는다.
  if (hasProjectMarker && expectedProjectId) {
    const markerProjectId = readMarkerProjectId(readProjectMarker(markerPath));

    if (markerProjectId && markerProjectId !== expectedProjectId) {
      return {
        valid: false,
        code: 'PROJECT_MISMATCH',
        reason:
          `Runner workspace ${normalizedAuthPath} belongs to a different AgentTeams project ` +
          `(${PROJECT_MARKER_RELATIVE_PATH} projectId ${markerProjectId} != ${expectedProjectId}); ` +
          `run aborted before start. ${WRONG_MACHINE_HINT}`,
      };
    }

    if (markerProjectId) {
      return { valid: true };
    }
    // 마커를 읽지 못했거나 projectId가 없으면 판정 불가로 보고 아래 폴백으로 내려간다.
  }

  if (hasProjectMarker || checkIsGitRepo(normalizedAuthPath)) {
    return { valid: true };
  }

  return {
    valid: false,
    code: 'NOT_A_PROJECT_DIRECTORY',
    reason:
      `Runner workspace ${normalizedAuthPath} exists on this runner but is neither a git repository nor an ` +
      `AgentTeams project (no ${PROJECT_MARKER_RELATIVE_PATH}); run aborted before start. ${WRONG_MACHINE_HINT}`,
  };
}
