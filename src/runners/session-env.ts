import type { RunnerOptions } from './types.js';

/**
 * 값이 없으면 키 자체를 생략하는 실행 스냅샷 변수들. 생략은 부모 환경에 같은 이름이
 * 없을 때만 "부재"가 된다. 데몬 프로세스가 이전 세션에서 이 값들을 상속했다면
 * `{ ...process.env, ...세션변수 }` 병합으로는 지울 수 없으므로, 자식 환경을 만들 때
 * 먼저 삭제한 뒤 현재 실행에 존재하는 값만 다시 싣는다.
 */
const EXECUTION_SNAPSHOT_ENV_KEYS = ['AGENTTEAMS_RUNNER_TYPE', 'AGENTTEAMS_MODEL', 'AGENTTEAMS_FAST_MODE'] as const;

/**
 * 러너가 spawn하는 자식 프로세스에 싣는 `AGENTTEAMS_*` 세션 환경변수 묶음을 만든다.
 *
 * 왜 공용 헬퍼인가: 주입 지점이 러너 10개 파일 13곳(POSIX 분기와 Windows PowerShell 분기)에
 * 흩어져 있다. 변수를 하나 추가할 때마다 같은 줄을 13번 복제하면 한 곳만 빠져도 그 러너의
 * 그 플랫폼에서만 값이 비는 침묵 버그가 된다. 세션 변수의 정의는 이 함수 한 곳에만 둔다.
 *
 * 왜 부재를 생략하는가: 빈 문자열이나 `"unknown"` 같은 자리표시자를 넣으면 소비자(CLI)가
 * "값이 있다"고 오판해 인자 폴백이 끊긴다. 부재는 키 자체를 빼서 부재로 남긴다.
 * 기존 `AGENTTEAMS_AGENT_NAME`이 따르던 규칙과 같다.
 */
export const buildAgentTeamsSessionEnv = (opts: RunnerOptions): Record<string, string> => {
  const env: Record<string, string> = {
    AGENTTEAMS_API_KEY: opts.apiKey,
    AGENTTEAMS_API_URL: opts.apiUrl,
    AGENTTEAMS_TEAM_ID: opts.teamId,
    AGENTTEAMS_PROJECT_ID: opts.projectId,
    AGENTTEAMS_AGENT_NAME: opts.agentConfigId,
  };

  // 실행 스냅샷 3종. CLI가 `--runner-type` / `--model` / `--fast`를 이 값들로 폴백하므로,
  // 여기서 내보내는 것은 "요청된 값"이 아니라 이 러너가 실제로 적용한 값이어야 한다.
  const runnerType = typeof opts.runnerType === 'string' ? opts.runnerType.trim() : '';
  if (runnerType.length > 0) {
    env.AGENTTEAMS_RUNNER_TYPE = runnerType;
  }

  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (model.length > 0) {
    env.AGENTTEAMS_MODEL = model;
  }

  // fastMode는 `true`일 때만 내보낸다. CLI `--fast`가 3-상태가 아닌 boolean 플래그라
  // 부재를 false로 읽으면 충분하고, `"false"` 문자열을 실으면 truthy 판정 실수를 유발한다.
  if (opts.fastMode === true) {
    env.AGENTTEAMS_FAST_MODE = 'true';
  }

  return env;
};

/**
 * 부모 환경에 세션 변수를 얹어 자식 프로세스가 그대로 쓸 완성 환경을 만든다.
 *
 * 왜 단순 스프레드가 아닌가: `buildAgentTeamsSessionEnv`는 부재를 키 생략으로 표현하는데,
 * 스프레드 병합은 생략된 키를 부모 값으로 채워버린다. 데몬이 이전 실행의
 * `AGENTTEAMS_MODEL`/`AGENTTEAMS_FAST_MODE`를 상속한 상태라면 현재 실행이 기본 모델·
 * 비-fast인데도 CLI 폴백이 그 오래된 값을 읽어 실제와 다른 실행 스냅샷을 기록한다.
 */
export const applyAgentTeamsSessionEnv = (
  baseEnv: NodeJS.ProcessEnv,
  sessionEnv: Record<string, string>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of EXECUTION_SNAPSHOT_ENV_KEYS) {
    delete env[key];
  }
  return Object.assign(env, sessionEnv);
};

/** 러너가 spawn에 그대로 넘기는 자식 환경. 세션 변수 생성과 부모 환경 정리를 한 번에 처리한다. */
export const buildRunnerChildEnv = (baseEnv: NodeJS.ProcessEnv, opts: RunnerOptions): NodeJS.ProcessEnv =>
  applyAgentTeamsSessionEnv(baseEnv, buildAgentTeamsSessionEnv(opts));
