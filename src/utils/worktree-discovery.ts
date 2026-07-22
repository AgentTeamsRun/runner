import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { DiscoveredWorktreeSyncItem, DiscoveredWorktreeSyncRepository, DiscoveryRepository } from '../types.js';
import { findMemberRepoCandidates, normalizeRemoteUrl } from './resolve-member-repo.js';
import { isGitRepo } from './git-worktree.js';
import { loadDiscoveredWorktreeMappings, saveDiscoveredWorktreeMappings } from './discovered-worktree-store.js';

/**
 * AgentRunner의 Git worktree 자동 발견·정합성 복구.
 *
 * `git worktree list --porcelain -z`를 파싱해 linked worktree만 골라 서버에 full snapshot으로 보고한다.
 * 핵심 계약:
 * - 머신 전체를 검색하지 않는다. 연결된(discovery 대상) repository로만 범위를 제한한다.
 * - `git worktree prune/remove`를 호출하지 않는다. 오직 읽기(list)만 한다.
 * - Git 명령 실패/malformed 출력은 해당 repository를 ok=false로 보고해 서버가 기존 상태를 보존하게 한다.
 *   빈 성공 snapshot으로 오인 보고하지 않는다.
 * - localKey는 canonical 경로의 해시로, 절대 경로를 서버 payload에 노출하지 않으면서 재시작 후에도 안정적으로 매칭된다.
 */

export type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

/**
 * `git worktree list --porcelain -z` 출력을 파싱한다.
 *
 * `-z`에서 각 attribute는 NUL로 종료되고, record는 빈 attribute(연속 NUL)로 구분된다.
 * 첫 record는 항상 main worktree다(git이 보장). 호출자가 필요 시 제외한다.
 */
export const parseWorktreePorcelain = (output: string): WorktreeRecord[] => {
  if (!output || !output.endsWith('\0\0')) {
    throw new Error('Malformed git worktree porcelain output: missing complete record terminator');
  }
  const records: WorktreeRecord[] = [];
  // NUL 구분 토큰. 마지막 빈 토큰(trailing NUL)은 무시된다.
  const tokens = output.split('\0');

  let current: WorktreeRecord | null = null;
  const flush = () => {
    if (current) {
      records.push(current);
      current = null;
    }
  };

  for (const token of tokens) {
    if (token === '') {
      // record 경계.
      flush();
      continue;
    }

    const spaceIndex = token.indexOf(' ');
    const key = spaceIndex === -1 ? token : token.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : token.slice(spaceIndex + 1);

    if (key === 'worktree') {
      flush();
      current = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!current) {
      throw new Error(`Malformed git worktree porcelain output: attribute before worktree (${key})`);
    }

    switch (key) {
      case 'HEAD':
        current.head = value || null;
        break;
      case 'branch':
        // refs/heads/<name> → <name>
        current.branch = value.replace(/^refs\/heads\//, '') || null;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.locked = true;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      default:
        break;
    }
  }
  flush();

  if (
    records.length === 0 ||
    records.some(
      (record) =>
        record.path.trim().length === 0 ||
        (!record.bare && !record.prunable && record.head === null) ||
        (!record.bare && !record.prunable && !record.detached && record.branch === null),
    )
  ) {
    throw new Error('Malformed git worktree porcelain output: incomplete worktree record');
  }

  return records;
};

/** canonical 경로를 서버에 노출하지 않는 daemon-scoped opaque 안정 키로 변환한다. */
export const computeLocalKey = (canonicalPath: string): string =>
  createHash('sha256').update(canonicalPath).digest('hex');

const runGitCapture = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

export type RepositoryDiscovery = {
  ok: boolean;
  items: DiscoveredWorktreeSyncItem[];
  // localKey → canonical worktree 경로. runner-side 실행 매핑에 사용한다(서버로 전송하지 않는다).
  mappings: Record<string, string>;
};

const canonicalize = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * 한 로컬 저장소의 linked worktree를 발견한다.
 *
 * main worktree(첫 record), bare, prunable은 제외한다. prunable/부재는 서버에서 보고 누락으로 MISSING 처리된다.
 * Git 명령이 실패하면 ok=false로 반환해 서버가 기존 상태를 보존하게 한다.
 *
 * @param runGit 테스트 주입용 git 실행기. 기본은 실제 `git` 호출.
 */
export const discoverRepositoryWorktrees = (
  repoPath: string,
  runGit: (args: string[], cwd: string) => string = runGitCapture,
): RepositoryDiscovery => {
  let output: string;
  try {
    output = runGit(['worktree', 'list', '--porcelain', '-z'], repoPath);
  } catch {
    // Git 명령 실패: 기존 상태 보존을 위해 ok=false.
    return { ok: false, items: [], mappings: {} };
  }

  let records: WorktreeRecord[];
  try {
    records = parseWorktreePorcelain(output);
  } catch {
    return { ok: false, items: [], mappings: {} };
  }

  const items: DiscoveredWorktreeSyncItem[] = [];
  const mappings: Record<string, string> = {};

  // 첫 record는 main worktree → 제외(기존 AgentConfig 실행 경로와 중복).
  for (const record of records.slice(1)) {
    if (record.bare || record.prunable) {
      continue;
    }
    const canonical = canonicalize(record.path);
    const localKey = computeLocalKey(canonical);
    items.push({
      localKey,
      branch: record.branch,
      headSha: record.head,
      displayName: record.branch ?? path.basename(canonical),
    });
    mappings[localKey] = canonical;
  }

  return { ok: true, items, mappings };
};

/** 로컬 저장소의 origin remote를 정규화 신원으로 변환한다. 매칭 실패 시 null. */
export const resolveRepositoryOrigin = (
  repoPath: string,
  runGit: (args: string[], cwd: string) => string = runGitCapture,
): string | null => {
  try {
    const origin = runGit(['remote', 'get-url', 'origin'], repoPath).trim();
    return origin ? normalizeRemoteUrl(origin) : null;
  } catch {
    return null;
  }
};

export type ReconcileDiscoveryDeps = {
  fetchDiscoveryRepositories: () => Promise<DiscoveryRepository[]>;
  syncDiscoveredWorktrees: (repositories: DiscoveredWorktreeSyncRepository[]) => Promise<void>;
  authPaths: string[];
  // 테스트 주입용 오버라이드.
  isGitRepo?: (dirPath: string) => boolean;
  findMemberRepoCandidates?: (root: string) => string[];
  resolveRepositoryOrigin?: (repoPath: string) => string | null;
  discoverRepositoryWorktrees?: (repoPath: string) => RepositoryDiscovery;
  loadMappings?: () => Record<string, string>;
  saveMappings?: (mappings: Record<string, string>) => void;
};

/**
 * 연결 저장소 범위에서 발견 worktree를 정합화하고 서버에 full snapshot을 보고한다.
 *
 * - discovery 대상 repository(remoteUrl)만 로컬 저장소 origin과 매칭한다. scope 밖은 Git 명령·payload 모두에서 제외한다.
 * - 로컬에서 매칭되지 않은 repository는 보고 목록에서 아예 제외한다(빈 성공 snapshot으로 MISSING 오탐 방지).
 * - 매칭됐지만 Git 조회 실패면 ok=false로 보고해 서버가 기존 상태를 보존하게 한다.
 * - localKey↔경로 매핑을 원자적으로 저장한다(민감 경로는 서버로 전송하지 않는다).
 */
export const reconcileDiscoveredWorktrees = async (deps: ReconcileDiscoveryDeps): Promise<void> => {
  const detectGitRepo = deps.isGitRepo ?? isGitRepo;
  const findCandidates = deps.findMemberRepoCandidates ?? findMemberRepoCandidates;
  const resolveOrigin = deps.resolveRepositoryOrigin ?? ((repoPath: string) => resolveRepositoryOrigin(repoPath));
  const discover = deps.discoverRepositoryWorktrees ?? ((repoPath: string) => discoverRepositoryWorktrees(repoPath));
  const loadMappings = deps.loadMappings ?? (() => loadDiscoveredWorktreeMappings());
  const saveMappings = deps.saveMappings ?? ((m: Record<string, string>) => void saveDiscoveredWorktreeMappings(m));

  const repositories = await deps.fetchDiscoveryRepositories();

  // 정규화된 remote 신원 → repositoryId (연결 범위).
  const remoteToRepoIds = new Map<string, string[]>();
  for (const repo of repositories) {
    if (!repo.remoteUrl) {
      continue;
    }
    const normalized = normalizeRemoteUrl(repo.remoteUrl);
    if (normalized) {
      const ids = remoteToRepoIds.get(normalized) ?? [];
      ids.push(repo.id);
      remoteToRepoIds.set(normalized, ids);
    }
  }

  type RepoAccumulator = {
    ok: boolean;
    items: Map<string, DiscoveredWorktreeSyncItem>;
    mappings: Record<string, string>;
  };
  const perRepo = new Map<string, RepoAccumulator>();

  for (const authPath of deps.authPaths) {
    let candidates: string[];
    try {
      candidates = detectGitRepo(authPath) ? [authPath] : findCandidates(authPath);
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      const normalized = resolveOrigin(candidate);
      if (!normalized) {
        continue;
      }
      const repositoryIds = remoteToRepoIds.get(normalized);
      if (!repositoryIds || repositoryIds.length === 0) {
        // discovery scope 밖 → 명령/보고 대상에서 제외.
        continue;
      }

      const discovery = discover(candidate);
      for (const repositoryId of repositoryIds) {
        const acc = perRepo.get(repositoryId) ?? { ok: false, items: new Map(), mappings: {} };
        // 여러 checkout이 같은 repository를 가리키면 ok는 AND(하나라도 실패면 보존), item/mapping은 localKey로 dedupe.
        acc.ok = perRepo.has(repositoryId) ? acc.ok && discovery.ok : discovery.ok;
        if (discovery.ok) {
          for (const item of discovery.items) {
            acc.items.set(item.localKey, item);
          }
          Object.assign(acc.mappings, discovery.mappings);
        }
        perRepo.set(repositoryId, acc);
      }
    }
  }

  if (perRepo.size === 0) {
    return;
  }

  const syncRepositories: DiscoveredWorktreeSyncRepository[] = [];
  const freshMappings: Record<string, string> = {};
  for (const [repositoryId, acc] of perRepo) {
    Object.assign(freshMappings, acc.mappings);
    syncRepositories.push({
      repositoryId,
      ok: acc.ok,
      worktrees: acc.ok ? Array.from(acc.items.values()) : [],
    });
  }

  // 스캔되지 않은 repository의 매핑은 실행을 위해 보존하고, 이번 cycle의 매핑을 합친다.
  try {
    saveMappings({ ...loadMappings(), ...freshMappings });
  } catch {
    // 매핑 저장 실패는 보고를 막지 않는다.
  }

  await deps.syncDiscoveredWorktrees(syncRepositories);
};
