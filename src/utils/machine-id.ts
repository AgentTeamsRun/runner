import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 머신 단위 신원(machineId).
 *
 * 러너와 CLI가 **같은 파일**을 공유해, "이 에이전트는 어느 머신에 등록됐는가"와 "이 러너는 어느
 * 머신에서 도는가"를 서버가 대조할 수 있게 한다. 비밀값이 아니며 인증/인가 판정에는 쓰지 않는다
 * (토큰 인증 이후의 부가 식별 정보).
 *
 * 파일 위치는 러너 설정(`~/.agentteams/daemon.json`)과 같은 디렉터리이지만, 토큰과 달리
 * 자격증명이 아니므로 러너 설정과 분리해 CLI도 읽을 수 있게 둔다.
 */
export const getMachineIdPath = (): string => join(homedir(), '.agentteams', 'machine-id');

export type MachineIdFileDependencies = {
  path?: string;
  readFile?: (path: string) => string;
  writeFileExclusive?: (path: string, content: string) => void;
  writeFileOverwrite?: (path: string, content: string) => void;
  generateId?: () => string;
};

const normalizeMachineId = (rawValue: string): string | null => {
  const normalized = rawValue.trim();
  return normalized.length > 0 ? normalized : null;
};

/**
 * machineId 파일을 읽고, 없으면 생성해 반환한다.
 *
 * 같은 머신에서 러너와 CLI가 동시에 실행될 수 있으므로 생성은 배타 쓰기(`wx`)로 수행하고,
 * 경쟁에서 진 쪽은 먼저 만들어진 값을 다시 읽어 같은 값을 반환한다. 어떤 이유로든 읽기·쓰기가
 * 모두 실패하면 `null`을 반환해 호출자가 machineId 없이 계속 진행하게 한다(기능 저하만 발생).
 */
export const readOrCreateMachineId = (dependencies: MachineIdFileDependencies = {}): string | null => {
  const path = dependencies.path ?? getMachineIdPath();
  const readFile = dependencies.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  const generateId = dependencies.generateId ?? randomUUID;
  const writeFile = (target: string, content: string, exclusive: boolean) => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w', mode: 0o600 });
    // umask의 영향을 받지 않도록 권한을 명시적으로 고정한다.
    chmodSync(target, 0o600);
  };
  const writeFileExclusive =
    dependencies.writeFileExclusive ?? ((target: string, content: string) => writeFile(target, content, true));
  const writeFileOverwrite =
    dependencies.writeFileOverwrite ?? ((target: string, content: string) => writeFile(target, content, false));

  try {
    const existing = normalizeMachineId(readFile(path));
    if (existing) {
      return existing;
    }
  } catch {
    // 파일이 없거나 읽을 수 없으면 아래에서 생성을 시도한다.
  }

  const generated = generateId();
  try {
    writeFileExclusive(path, `${generated}\n`);
    return generated;
  } catch {
    // 배타 쓰기 실패는 두 경우다: (1) 다른 프로세스가 먼저 만들었다 → 그 값을 쓴다,
    // (2) 파일은 있는데 비어 있다(중단된 쓰기 등) → 스스로 복구해 다시 채운다.
    try {
      const raced = normalizeMachineId(readFile(path));
      if (raced) {
        return raced;
      }
    } catch {
      return null;
    }

    try {
      writeFileOverwrite(path, `${generated}\n`);
      return generated;
    } catch {
      return null;
    }
  }
};

let cachedMachineId: string | null | undefined;

/**
 * 프로세스 수명 동안 machineId를 한 번만 해석해 재사용한다(요청마다 파일 I/O를 하지 않는다).
 */
export const getMachineId = (): string | null => {
  if (cachedMachineId === undefined) {
    cachedMachineId = readOrCreateMachineId();
  }

  return cachedMachineId;
};

/** 테스트 전용: 캐시를 비운다. */
export const resetMachineIdCache = (): void => {
  cachedMachineId = undefined;
};
