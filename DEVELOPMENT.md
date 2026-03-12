# AgentRunner - 개발자 가이드

이 문서는 AgentRunner(daemon) 패키지를 개발하거나 로컬에서 테스트하는 개발자를 위한 가이드입니다.

공개용 사용자 문서는 `readme.md`를 참고하세요.

## 사전 준비

- Node.js 18+
- npm 10+
- AgentTeams API 서버 실행 중
- 웹에서 발급한 데몬 토큰 (`x-daemon-token`)

## 로컬 설정

### 1. API 서버 준비

로컬 개발 시 API 서버가 실행되어 있어야 합니다.

```bash
cd api
npm install
npm run prisma:generate
npm run dev
# http://localhost:3001
```

### 2. 의존성 설치 및 빌드

```bash
cd daemon
npm install
npm run build
```

### 3. 전역 링크 (로컬 테스트용)

```bash
cd daemon
npm run build
npm link
agentrunner --help
```

또는 전역 설치:

```bash
cd daemon
npm install
npm run build
npm install -g .
```

#### zsh: permission denied: agentteams-daemon

```
chmod +x /Users/justin/Project/Me/AgentTeams/daemon/dist/index.js
```

### 4. 초기 설정

```bash
# 로컬 API 서버 사용 (플랫폼 개발자)
agentrunner init --token <TOKEN> --api-url http://localhost:3001

# 자동 시작 없이 토큰만 저장
agentrunner init --token <TOKEN> --api-url http://localhost:3001 --no-autostart
```

### 5. 실행

```bash
# 직접 실행
agentrunner start

# 실행 중인 러너 재시작
agentrunner restart

# 최신 npm 배포본 설치 후 재시작
agentrunner update

# 또는 빌드 없이 개발 모드
npm run dev
```

## init 옵션 전체

| 옵션 | 필수 | 설명 |
|---|---|---|
| `--token <token>` | ✅ | 웹에서 발급한 데몬 토큰 |
| `--api-url <url>` | | API 서버 URL (기본값: `https://api.agentteams.run`) |
| `--no-autostart` | | 자동 시작 등록을 건너뜀 |

> `--api-url`은 플랫폼 개발자 전용입니다. 일반 사용자 문서(readme.md)에는 노출하지 않습니다.

## 설정 우선순위

### 토큰

1. `AGENTTEAMS_DAEMON_TOKEN` 환경변수
2. `~/.agentteams/daemon.json`의 `daemonToken`

### API URL

1. `--api-url` 인자 (init 시)
2. `AGENTTEAMS_API_URL` 환경변수
3. `~/.agentteams/daemon.json`의 `apiUrl`
4. 기본값: `https://api.agentteams.run`

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `POLLING_INTERVAL_MS` | `30000` (30초) | 트리거 폴링 주기 |
| `TIMEOUT_MS` | `1800000` (30분) | 러너 프로세스 타임아웃 |
| `RUNNER_CMD` | `opencode` | 에이전트 실행 명령어 |
| `CODEX_SANDBOX_LEVEL` | `off` | Codex 러너 샌드박스 레벨. `workspace-write` 또는 `off` 허용. 자동시작·수동 시작 모두 기본값 `off` |
| `LOG_LEVEL` | `info` | 로그 레벨: `debug`, `info`, `warn`, `error` |
| `DAEMON_VERBOSE_RUNNER_LOGS` | `true` | `false`면 시작/종료/에러 로그만 출력 |
| `DAEMON_PROMPT_LOG_MODE` | `preview` | 프롬프트 로그: `off`, `length`, `preview`, `full` |

> `CODEX_SANDBOX_LEVEL=off`는 `codex --dangerously-bypass-approvals-and-sandbox`를 사용합니다. Git 쓰기와 임의 명령 실행이 모두 가능해지므로 로컬 개발/검증 용도로만 사용하세요.
>
> **자동시작과 수동 시작의 동작 통일**: 자동시작 서비스 파일(launchd/systemd/Startup)은 `CODEX_SANDBOX_LEVEL=off`를 환경변수로 주입합니다. 수동 `agentrunner start`도 동일하게 `CODEX_SANDBOX_LEVEL`이 설정되지 않은 경우 `off`로 기본값을 적용합니다. 명시적으로 `CODEX_SANDBOX_LEVEL=workspace-write agentrunner start`처럼 지정하면 해당 값이 우선됩니다.

## 프로젝트 구조

```
daemon/
├── src/
│   ├── commands/          # 커맨드 구현
│   │   ├── init.ts        # 토큰 저장 + 자동 시작 등록
│   │   ├── start.ts       # 폴링 시작 (기본 커맨드)
│   │   ├── status.ts      # PID + 자동 시작 상태 확인
│   │   ├── stop.ts        # SIGTERM 전송
│   │   ├── restart.ts     # 현재 러너 재시작
│   │   ├── update.ts      # 최신 npm 패키지 설치 후 재시작
│   │   └── uninstall.ts   # 중지 + 서비스 해제 + 정리
│   ├── handlers/          # 트리거 처리 핸들러
│   │   └── trigger-handler.ts
│   ├── runners/           # 러너 프로세스 실행
│   ├── api-client.ts      # AgentTeams API 클라이언트
│   ├── autostart.ts       # OS별 자동 시작 서비스 (launchd/systemd/Task Scheduler)
│   ├── config.ts          # 설정 로딩/병합
│   ├── logger.ts          # 로거
│   ├── pid.ts             # PID 파일 관리
│   ├── poller.ts          # 트리거 폴링 루프
│   ├── types.ts           # 타입 정의
│   └── index.ts           # CLI 진입점 + 커맨드 라우팅
├── dist/                  # 빌드 산출물 (gitignored)
├── package.json
├── tsconfig.json
├── readme.md              # 사용자용 문서 (npm 공개용, 영어)
└── DEVELOPMENT.md         # 이 문서 (개발자용, 한국어)
```

## 자동 시작 서비스

`init` 실행 시 OS에 맞는 서비스를 등록합니다.

| OS | 방식 | 서비스 파일 |
|---|---|---|
| macOS | launchd | `~/Library/LaunchAgents/run.agentteams.runner.plist` |
| Linux | systemd (user) | `~/.config/systemd/user/agentrunner.service` |
| Windows | Startup folder | `~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/agentrunner-start.vbs` |

### 서비스 디버깅

```bash
# macOS: 서비스 상태 확인
launchctl list run.agentteams.runner
cat /tmp/agentrunner.log
cat /tmp/agentrunner-error.log

# Linux: 서비스 상태 확인
systemctl --user status agentrunner
journalctl --user -u agentrunner -f

# Windows: Startup script 확인
dir "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\agentrunner-start.vbs"
```

## 동작 흐름

1. `start` → 폴링 루프 시작, PID 파일 기록
2. pending 트리거 폴링 → claim
3. 런타임 정보 조회 (작업 경로, API 키)
4. `RUNNER_CMD run "<prompt>"` 프로세스 실행
5. 종료 코드/타임아웃에 따라 트리거 상태 업데이트
6. 동일 `agentConfigId`에 프로세스 실행 중이면 → `REJECTED`

## 업데이트/재시작 UX

- `agentrunner restart`
  - 자동 시작 등록이 있으면 해당 OS 등록 경로로 재시작
  - 자동 시작 등록이 없으면 detached 백그라운드 프로세스로 다시 시작
- `agentrunner update`
  - `npm install -g @rlarua/agentrunner@latest`
  - 설치 성공 후 `restart` 흐름 수행
  - Windows는 서비스 재기동이 아니라 Startup script를 다시 실행하는 UX

## 로그

- **데몬 로그**: 콘솔 출력 (자동 시작 시 OS 로그 시스템으로 전달)
  - macOS: `/tmp/agentrunner.log`, `/tmp/agentrunner-error.log`
  - Linux: `journalctl --user -u agentrunner -f`
  - Windows: 이벤트 뷰어 → Windows 로그 → 응용 프로그램 (`AgentRunner`)
- **태스크 로그**: `<작업경로>/.agentteams/daemonLog/daemon-<triggerId>.log`

## 개발 워크플로우

### 타입 체크

```bash
npm run build  # tsc가 타입 체크 수행
```

### 커맨드 테스트

```bash
# 빌드 후 직접 실행
node dist/index.js --help
node dist/index.js status
node dist/index.js init --token test_token --api-url http://localhost:3001 --no-autostart
node dist/index.js restart
node dist/index.js update

# 개발 모드 (watch)
npm run dev
```

### 새 커맨드 추가

1. `src/commands/`에 커맨드 파일 생성:
   ```typescript
   // src/commands/my-command.ts
   export const runMyCommand = async (): Promise<void> => {
     // 구현
   };
   ```

2. `src/index.ts`에 라우팅 추가:
   ```typescript
   if (command === "my-command") {
     await runMyCommand();
     return;
   }
   ```

3. `helpText`에 커맨드 설명 추가

## npm 배포

GitHub Actions(`.github/workflows/publish-runner.yml`)로 자동 배포됩니다.

- **트리거**: `main` 브랜치에 `daemon/**` 경로 push 시
- **패키지**: `@rlarua/agentrunner`
- **레지스트리**: npm

수동 배포:

```bash
cd daemon
npm run build
npm publish --access public
```

## 자주 발생하는 문제

### `zsh: permission denied: agentrunner`

전역 링크된 실행 파일의 권한/경로 문제입니다.

```bash
type -a agentrunner
which agentrunner
ls -l "$(which agentrunner)"
```

재빌드 후 재설치:

```bash
cd daemon
npm run build
npm install -g .
hash -r
```

그래도 안 되면 실행 권한 확인:

```bash
chmod +x $(which agentrunner)
```

### API 서버 연결 불가

로컬 API 서버 상태 확인:

```bash
curl http://localhost:3001/api/health
# {"status":"ok"}
```

### 설정 파일 위치

```bash
cat ~/.agentteams/daemon.json
```

## 네이밍 규칙

| 항목 | 값 | 비고 |
|---|---|---|
| npm 패키지 | `@rlarua/agentrunner` | |
| CLI 명령어 | `agentrunner` | |
| 환경변수 접두사 | `AGENTTEAMS_DAEMON_` | 기존 호환 유지 |
| API 엔드포인트 | `/daemon-*` | 기존 호환 유지 |
| 내부 코드 | `daemon*` (변수/클래스명) | DaemonApiClient 등 |
| launchd 라벨 | `run.agentteams.runner` | |
| systemd 서비스 | `agentrunner.service` | |
| Windows 태스크 | `AgentRunner` | |
