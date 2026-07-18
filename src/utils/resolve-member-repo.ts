import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isGitRepo } from './git-worktree.js';

// windowsHide 누락 시 콘솔 미부착 부모(데몬)가 git.exe를 띄울 때 콘솔 창이 노출된다.
function runGit(args: string[], cwd: string): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// 프로토콜별 기본 포트. URL은 http/https/ftp의 기본 포트를 스스로 지우지만
// ssh/git 같은 비표준 스킴은 지우지 않으므로 직접 비교해 제거한다.
const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
  'git:': '9418',
  'ftp:': '21',
};

/**
 * Normalize a git remote URL to a comparable `host[:port]/owner/repo` form.
 *
 * Handles scheme URLs (`https://`, `ssh://`, `git://`) and scp-like syntax
 * (`git@host:owner/repo`). Strips user info, a trailing `.git` suffix, and
 * trailing slashes, then lowercases the result so that the same repository
 * registered over https matches an ssh origin (and vice versa). A non-default
 * port stays part of the identity — self-hosted services on different ports of
 * the same host are different servers — while protocol-default ports (https
 * 443, ssh 22, ...) match their port-less form.
 */
export function normalizeRemoteUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let host: string;
  let pathname: string;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const defaultPort = DEFAULT_PORTS[parsed.protocol];
      host = parsed.port && parsed.port !== defaultPort ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    // scp-like syntax: [user@]host:owner/repo
    const scpMatch = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (!scpMatch) return null;
    host = scpMatch[1];
    pathname = scpMatch[2];
  }

  const normalizedPath = pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!host || !normalizedPath) return null;

  return `${host}/${normalizedPath}`.toLowerCase();
}

// git 출력이 상대 경로일 가능성에 대비해 CLI findMemberRepos와 같은 방식으로 절대화한다.
function resolveGitTopLevel(candidate: string): string | null {
  const topLevel = runGit(['rev-parse', '--show-toplevel'], candidate);
  if (!topLevel) return null;
  return path.isAbsolute(topLevel) ? path.resolve(topLevel) : path.resolve(candidate, topLevel);
}

/**
 * Discover member git repositories directly under a non-git project root.
 *
 * Judgement criteria are kept in contract with the CLI's `findMemberRepos`
 * (cli/src/utils/projectLayout.ts): only physical directories at depth 1 are
 * considered; hidden directories, `node_modules`, symlinked directories, and
 * bare repositories are excluded; a candidate counts only when its canonical
 * path is itself the top level of a git work tree. Results are sorted by path
 * for deterministic output.
 */
export function findMemberRepoCandidates(rootDir: string): string[] {
  const root = path.resolve(rootDir);

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const members: string[] = [];

  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks, which keeps symlinked
    // directories out without an extra lstat call.
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const candidate = path.join(root, entry.name);

    // Bare repositories have no work tree, so --show-toplevel resolves null.
    const topLevel = resolveGitTopLevel(candidate);
    if (!topLevel) continue;

    let canonical: string;
    try {
      canonical = realpathSync(candidate);
    } catch {
      continue;
    }

    // Requiring canonical equality keeps out candidates that merely live
    // inside some other repository's work tree.
    if (canonical !== topLevel) continue;

    members.push(candidate);
  }

  return members.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type WorktreeAuthPathResolution = { path: string } | { error: string };

const RUNNER_BOX_OFF_HINT = 'Turn off the runner box (worktree) option and request the run again.';

/**
 * Resolve the repository to create a worktree from.
 *
 * If `authPath` itself is a git repository it is returned as-is. Otherwise the
 * project repository's `remoteUrl` is matched against the `origin` remote of
 * each member repository directly under `authPath`; exactly one match resolves
 * to that member repository, while a missing remote URL, zero matches, or
 * multiple matches fail with a user-facing explanation. There is no silent
 * fallback to running on the non-git root.
 */
export function resolveWorktreeAuthPath(
  authPath: string,
  repositoryRemoteUrl: string | null,
): WorktreeAuthPathResolution {
  if (isGitRepo(authPath)) {
    return { path: authPath };
  }

  if (repositoryRemoteUrl === null) {
    return {
      error:
        `Worktree requested but ${authPath} is not a git repository and the selected repository has no remote URL, ` +
        `so a member repository cannot be resolved. ${RUNNER_BOX_OFF_HINT}`,
    };
  }

  // ProjectRepository.remoteUrl은 임의 문자열이라 credential 포함 URL
  // (https://user:token@host/repo.git)일 수 있다. 오류는 서버 로그·트리거 로그·
  // worktreeError로 영구 전송되므로 raw URL을 절대 보간하지 않는다 — 표시에는
  // userinfo/query가 제거된 정규화 신원(host/owner/repo)만 사용한다.
  const normalizedTarget = normalizeRemoteUrl(repositoryRemoteUrl);
  if (!normalizedTarget) {
    return {
      error:
        `Worktree requested but ${authPath} is not a git repository and the selected repository remote URL ` +
        `is not recognized. ${RUNNER_BOX_OFF_HINT}`,
    };
  }

  const matches = findMemberRepoCandidates(authPath).filter((candidate) => {
    const origin = runGit(['remote', 'get-url', 'origin'], candidate);
    if (!origin) return false;
    return normalizeRemoteUrl(origin) === normalizedTarget;
  });

  if (matches.length === 0) {
    return {
      error:
        `Worktree requested but no member repository under ${authPath} has an origin remote matching ` +
        `${normalizedTarget}. ${RUNNER_BOX_OFF_HINT}`,
    };
  }

  if (matches.length > 1) {
    return {
      error:
        `Worktree requested but multiple member repositories under ${authPath} have an origin remote matching ` +
        `${normalizedTarget} (${matches.map((match) => path.basename(match)).join(', ')}). ${RUNNER_BOX_OFF_HINT}`,
    };
  }

  return { path: matches[0] };
}
