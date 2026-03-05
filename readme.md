# AgentRunner 사용 가이드

이 문서는 `daemon/` 패키지의 실행 방법과 설정 방법을 설명합니다.

## 1. 사전 준비

- Node.js `24` 이상
- AgentTeams API 서버 실행 중
- 웹에서 발급한 데몬 토큰 (`x-daemon-token`)

## 2. 설치 및 빌드

`daemon/` 디렉터리에서 아래 명령을 실행하세요.

```bash
cd daemon
npm install
npm run build
```

## 2-1. 전역 설치

전역 명령어(`agentrunner`)로 사용하려면 아래 순서로 설치하세요.

```bash
cd daemon
npm install
npm run build
npm install -g .
```

설치 확인:

```bash
agentrunner --help
```

개발 중에는 전역 설치 대신 링크 방식도 사용할 수 있습니다.

```bash
cd daemon
npm run build
npm link
```

## 3. 초기 설정 (`init`)

토큰 저장과 OS 자동 시작 등록을 한 번에 수행합니다.

```bash
agentrunner init --token <DAEMON_TOKEN>
```

`init`은 다음을 수행합니다:

1. 토큰을 `~/.agentteams/daemon.json`에 저장
2. API 서버에서 토큰 유효성 검증
3. OS에 맞는 자동 시작 서비스 등록 및 즉시 시작
   - **macOS**: `~/Library/LaunchAgents/run.agentteams.daemon.plist` (launchd)
   - **Linux**: `~/.config/systemd/user/agentrunner.service` (systemd)

### 옵션

- `--token <token>` — **필수**. 웹에서 발급한 데몬 토큰
- `--api-url <url>` — 선택. API 서버 URL (기본값: `https://api.agentteams.run`)
- `--no-autostart` — 선택. 자동 시작 등록을 건너뜀 (수동 실행만 사용할 때)

예시:

```bash
# 일반 사용자 (자동 시작 포함)
agentrunner init --token daemon_xxxxx

# 플랫폼 개발자 (커스텀 API URL)
agentrunner init --token daemon_xxxxx --api-url http://localhost:3001

# 자동 시작 없이 토큰만 저장
agentrunner init --token daemon_xxxxx --no-autostart
```

`--api-url` 생략 시 아래 우선순위로 결정됩니다:

1. `AGENTTEAMS_API_URL` 환경변수
2. 기존 설정 파일의 `apiUrl`
3. 기본값 `https://api.agentteams.run`

## 4. 실행 (`start`)

```bash
agentrunner start
```

명령어를 생략해도 기본 동작은 `start`입니다.

```bash
agentrunner
```

> `init`에서 자동 시작을 등록했다면 `start`를 수동으로 실행할 필요 없습니다.
> 로그인/부팅 시 OS가 자동으로 시작합니다.

## 5. 상태 확인 (`status`)

```bash
agentrunner status
```

데몬 프로세스 실행 여부와 자동 시작 등록 상태를 확인합니다.

출력 예시:

```
[...] INFO Daemon is running { pid: 12345 }
[...] INFO Autostart is enabled { platform: 'launchd' }
```

## 6. 중지 (`stop`)

```bash
agentrunner stop
```

실행 중인 데몬 프로세스에 SIGTERM을 보내 정상 종료합니다.

> 자동 시작이 등록된 경우, OS가 데몬을 자동 재시작할 수 있습니다.
> 완전히 중지하려면 `uninstall`을 사용하세요.

## 7. 제거 (`uninstall`)

```bash
agentrunner uninstall
```

다음을 수행합니다:

1. 실행 중인 데몬 프로세스 중지
2. OS 자동 시작 서비스 해제 및 서비스 파일 삭제
3. PID 파일 정리

## 8. 설정 우선순위

실행 시 설정은 아래 우선순위로 적용됩니다.

### 토큰

1. `AGENTTEAMS_DAEMON_TOKEN`
2. `~/.agentteams/daemon.json`의 `daemonToken`

### API URL

1. `AGENTTEAMS_API_URL`
2. `~/.agentteams/daemon.json`의 `apiUrl`
3. 기본값 `https://api.agentteams.run`

### 기타 옵션

- `POLLING_INTERVAL_MS`
  - 기본값: `30000` (30초)
- `TIMEOUT_MS`
  - 기본값: `1800000` (30분)
- `RUNNER_CMD`
  - 기본값: `opencode`
- `LOG_LEVEL`
  - 기본값: `info`
  - 값: `debug | info | warn | error`
- `DAEMON_VERBOSE_RUNNER_LOGS`
  - 기본값: `true`
  - 값: `true | false`
  - 설명: `false`면 runner stdout/stderr 상세 로그를 줄이고 시작/종료/에러 중심으로 출력
- `DAEMON_PROMPT_LOG_MODE`
  - 기본값: `preview`
  - 값: `off | length | preview | full`
  - 설명:
    - `off`: 프롬프트 로그 미출력
    - `length`: 프롬프트 길이만 출력
    - `preview`: 프롬프트 미리보기(일부) 출력
    - `full`: 프롬프트 전체 출력

## 9. 동작 개요

`start` 실행 후 데몬은 다음 흐름으로 동작합니다.

1. 주기적으로 pending 트리거를 폴링합니다.
2. 트리거를 claim합니다.
3. 런타임 정보(작업 경로, API 키)를 조회합니다.
4. `RUNNER_CMD run "<prompt>"` 형식으로 프로세스를 실행합니다.
5. 종료 코드/타임아웃 결과에 따라 트리거 상태를 업데이트합니다.

동일 `agentConfigId`에 실행 중인 프로세스가 있으면 새 트리거는 `REJECTED` 처리됩니다.

## 10. 로그

- 데몬 자체 로그: 콘솔 출력 (자동 시작 시 OS 로그 시스템으로 전달)
  - **macOS**: `/tmp/agentrunner.log`, `/tmp/agentrunner-error.log`
  - **Linux**: `journalctl --user -u agentrunner -f`
- 러너(stdout/stderr) 로그: 작업 경로의 `.agentteams/daemonLog/daemon-<triggerId>.log`

## 11. 자주 발생하는 오류

### `Missing token. Usage: agentrunner init --token <token> ...`

- `init` 명령에서 `--token`을 넣지 않은 경우입니다.

### `Daemon token is missing. Run 'agentrunner init --token <token>' first.`

- 실행 시 토큰을 찾을 수 없는 상태입니다.
- `init`을 먼저 실행하거나 `AGENTTEAMS_DAEMON_TOKEN` 환경변수를 설정하세요.

### `zsh: permission denied: agentrunner`

- 전역으로 연결된 `agentrunner` 실행 파일의 권한/경로 문제일 가능성이 큽니다.
- 아래 순서로 확인/복구하세요.

```bash
type -a agentrunner
which agentrunner
ls -l "$(which agentrunner)"
```

```bash
cd daemon
npm run build
npm install -g .
hash -r
```

- 그래도 동일하면 실행 파일 권한을 확인하세요.

```bash
chmod +x /Users/justin/Project/Me/AgentTeams/daemon/dist/index.js
```
