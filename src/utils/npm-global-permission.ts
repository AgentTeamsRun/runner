import { accessSync, constants } from 'node:fs';
import { platform as getPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { getNpmGlobalBinPath } from '../executable.js';

/**
 * 전역 npm 모듈 루트에 쓸 수 있는지 미리 판정한다.
 *
 * 리눅스 기본 설치(`npm prefix -g` = `/usr/local`, `/usr/local/lib/node_modules`가 root 소유)에서
 * `--user` systemd 서비스로 도는 러너는 `npm install -g`가 항상 EACCES로 죽는다. 실행해봐야 실패할
 * 설치를 매시간 반복하지 않도록 설치 직전에 이 판정을 먼저 한다.
 *
 * ⚠️ fail-open: prefix를 못 구하거나 판정 중 예외가 나면 `true`를 돌려준다. 정상 환경의 자동
 * 업데이트를 새로 막는 것이 반복 실패보다 나쁘기 때문이다.
 */
export type NpmGlobalPermissionDeps = {
  npmGlobalPrefix?: () => string | null;
  accessSync?: typeof accessSync;
  platform?: typeof getPlatform;
};

/** 전역 모듈 루트 경로. win32는 prefix 바로 아래, POSIX는 `<prefix>/lib/node_modules`. */
const resolveGlobalModulesRoot = (prefix: string, os: NodeJS.Platform): string =>
  os === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');

export const canWriteGlobalNpmRoot = (deps: NpmGlobalPermissionDeps = {}): boolean => {
  const resolvePrefix = deps.npmGlobalPrefix ?? (() => getNpmGlobalBinPath());
  const access = deps.accessSync ?? accessSync;
  const os = (deps.platform ?? getPlatform)();

  try {
    const prefix = resolvePrefix();
    if (!prefix) {
      return true; // prefix를 못 구하면 판정 불가 → fail-open
    }

    // 설치 대상 디렉터리가 아직 없을 수 있다(최초 전역 설치). 존재하는 가장 가까운 상위 경로로
    // 올라가 그곳의 쓰기 권한으로 판정한다.
    let candidate = resolveGlobalModulesRoot(prefix, os);
    for (;;) {
      try {
        access(candidate, constants.W_OK);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          return false; // EACCES/EPERM 등 → 쓰기 불가로 확정
        }

        const parent = dirname(candidate);
        if (parent === candidate) {
          return true; // 루트까지 올라가도 못 찾음 → 판정 불가 → fail-open
        }
        candidate = parent;
      }
    }
  } catch {
    return true; // 예상 못 한 예외 → fail-open
  }
};
