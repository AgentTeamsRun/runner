import { basename } from 'node:path';

/**
 * 별칭(`agr`)은 사람이 터미널에서 직접 치는 이름 전용입니다.
 * 자동시작 산출물·설치 안내·에이전트 가이드에는 정식 이름(`agentrunner`)만 씁니다.
 */
export const CANONICAL_RUNNER_NAME = 'agentrunner';

const INVOCATION_NAMES = new Set<string>([CANONICAL_RUNNER_NAME, 'agr']);

/**
 * 실행 파일명을 화이트리스트로 검증해 usage 문구에 쓸 이름을 정합니다.
 * basename을 그대로 쓰면 테스트 러너나 래퍼 스크립트로 실행할 때 엉뚱한 이름이 안내되므로,
 * 등록된 이름이 아니면 정식 이름으로 폴백합니다.
 *
 * 별칭 이름이 실제로 표시되는 것은 bin을 심링크로 까는 환경(POSIX + npm 전역 설치)뿐입니다.
 * Windows의 `agr.cmd`/`agr.ps1` shim과 pnpm 전역 래퍼는 `node "<...>/dist/index.js"`를 실행해
 * `process.argv[1]`이 항상 진입 스크립트가 되므로, 이 환경에서는 정식 이름으로 폴백합니다(의도된 동작).
 */
export const resolveInvokedName = (candidate: string = basename(process.argv[1] ?? '')): string =>
  INVOCATION_NAMES.has(candidate) ? candidate : CANONICAL_RUNNER_NAME;

export const buildHelpText = (
  invokedName?: string,
): string => `Usage: ${resolveInvokedName(invokedName)} [command] [options]

Commands:
  start                       Start daemon polling (default)
  init --token <token>        Initialize daemon config and register autostart
  status                      Show daemon and autostart status
  stop                        Stop running daemon
  restart                     Restart daemon using autostart or background spawn
  update                      Install latest AgentRunner package and restart
  uninstall                   Stop daemon, remove autostart, clean up
  cleanup --path <path>       Purge expired runner log/history files

Options:
  --no-autostart              Skip autostart registration (init only)
  -h, --help                  Show help
  -v, --version               Show version
`;
