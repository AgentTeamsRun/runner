# Runner Permission Reference

## Runner별 권한 설정

| Runner          | CLI        | 권한 플래그                      | 샌드박스                                |
| --------------- | ---------- | -------------------------------- | --------------------------------------- |
| **Claude Code** | `claude`   | `--dangerously-skip-permissions` | 전체 스킵                               |
| **AMP**         | `ampcode`  | `--dangerously-allow-all`        | 전체 스킵                               |
| **Codex**       | `codex`    | `CODEX_SANDBOX_LEVEL` 환경변수   | `workspace-write` (기본) 또는 `off`     |
| **OpenCode**    | `opencode` | 없음                             | 없음                                    |
| **Cursor CLI**  | `agent`    | `--force`                        | 명시적으로 거부되지 않은 명령 자동 허용 |

Cursor CLI의 `--force`는 비대화형 실행 중 파일 변경과 셸 명령을 자동 승인합니다. 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다. Cursor 로그인 세션과 `CURSOR_API_KEY`는 Cursor가 관리하며 AgentTeams는 인증 값이나 `.cursor` 설정을 생성·변경하지 않습니다.

## 워크트리 설정 (`healWorktreeConfig`)

- `.agentteams` 심볼릭 링크: 원본 레포 → 워크트리
- `.env*` 파일: 원본 레포에서 워크트리로 **복사** (symlink 아님, Prisma 호환성)
- `settings.local.json`: 생성하지 않음 (`--dangerously-skip-permissions`로 불필요)

## 에이전트별 로그 수집 방식

| Runner          | stdout 포맷                                                         | 파싱                                                     | 로그 수집 방식                                                                               |
| --------------- | ------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Claude Code** | stream-json (`--output-format stream-json`)                         | `createStreamJsonLineParser` → 구조화된 로그             | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록                               |
| **AMP**         | stream-json (`--stream-json-thinking`)                              | `createStreamJsonLineParser` → 구조화된 로그             | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록                               |
| **Codex**       | plain text                                                          | 없음 (raw output 그대로)                                 | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록                                        |
| **OpenCode**    | plain text                                                          | 없음 (raw output 그대로)                                 | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록                                        |
| **Cursor CLI**  | stream-json (`--output-format stream-json --stream-partial-output`) | `createCursorStreamJsonLineParser` → bounded 구조화 로그 | assistant delta를 병합하고 안전한 tool 상태만 `onStdoutChunk`로 전달, raw를 logStream에 기록 |

### stream-json 파서 (`stream-json-parser.ts`)

Claude Code와 AMP의 stdout은 JSON lines 형식이며, 파서가 다음 타입을 처리:

- `system` — 세션 초기화 정보
- `assistant` — thinking, text, tool_use, tool_result
- `result` — 최종 완료 상태 (duration, turn count)

파서는 길이 제한을 적용: thinking 300자, text 500자, tool input 200자.

Cursor CLI는 별도 상태형 파서를 사용합니다. 작은 `assistant` text delta는 문장·개행·도구 이벤트·`result`·종료 또는 800자 상한에서만 flush하고, 같은 turn의 partial 누적값과 동일한 최종 assistant 이벤트는 중복 기록하지 않습니다. `user` prompt, `system.apiKeySource`, 알 수 없는 이벤트, terminal 명령 본문과 `tool_call.completed.result` body는 서버 가시 로그에 전달하지 않고, 도구명·안전한 경로·시작/완료/실패 상태만 요약합니다. terminal `result.result`는 로그 body로 노출하지 않지만 fallback history용 `outputText`에는 보존합니다.

### 로그 흐름 (공통)

```
runner stdout ──┬── logStream (raw) ──→ .agentteams/runner/log/{triggerId}.log
                │
                ├── streamParser (Claude Code/AMP/Cursor CLI) ──→ onStdoutChunk (파싱된 메시지)
                │   또는 raw output (Codex/OpenCode) ──→ onStdoutChunk
                │
                └── outputText (메모리, 최대 200KB) ──→ fallback history 용
                    └── extractResultTextFromStreamJson (stream-json인 경우 result 추출)

onStdoutChunk ──→ TriggerLogReporter ──→ API 배치 전송
```

## 로그 확인 방법

### 데몬 로그 (launchd)

```bash
# stdout
cat /tmp/agentrunner.log

# stderr
cat /tmp/agentrunner-error.log

# 실시간 추적
tail -f /tmp/agentrunner.log
```

데몬은 `console.log/warn/error`로 출력하며 launchd가 위 경로로 리다이렉트합니다.
로그 포맷: `[2026-03-18T14:00:00.000Z] INFO|WARN|ERROR <message> {meta}`

### 러너 실행 로그 (트리거별)

각 트리거 실행 시 러너의 raw stdout/stderr가 파일로 기록됩니다:

```
{authPath}/.agentteams/runner/log/{triggerId}.log
```

### 러너 히스토리 (트리거별)

러너가 작성한 마크다운 히스토리 파일:

```
{authPath}/.agentteams/runner/history/{triggerId}.md
```

러너가 히스토리를 작성하지 못한 경우 `trigger-handler`가 stdout에서 fallback history를 생성하여 서버에 보고합니다.

### API 로그 리포터

실시간으로 파싱된 로그가 API로 전송됩니다:

- `POST /api/daemon-triggers/{triggerId}/logs` — 배치 전송 (50개씩, 2초 간격)
- 웹 UI에서 트리거 상세 화면으로 확인 가능

## 히스토리 및 변경 이력

### 2026-03-18: Claude Code 권한 이슈 수정

워크트리에서 Claude Code 러너 실행 시 `.agentteams` 심볼릭 링크가 샌드박스 밖으로 resolve되어 파일 읽기/쓰기/CLI 실행이 차단되던 문제.

**시도한 접근 (모두 불충분):**

1. `sandbox.filesystem.allowWrite` → 쓰기만 허용, 읽기 차단
2. `permissions.additionalDirectories` → 읽기 허용, 쓰기/bash 차단
3. `permissions.allow: ["Bash(agentteams *)"]` → CLI만 허용, 파일 쓰기 차단

**최종 해결:** `--dangerously-skip-permissions` 플래그 추가로 모든 권한 우회.

### 2026-03-18: .env 복사 방식 변경

워크트리에서 `.env` 파일을 심볼릭 링크로 공유하면 Prisma가 경로를 resolve하지 못하는 문제. `symlinkSync` → `copyFileSync`로 변경.

### 2026-03-18: fallback history JSON 파싱

stream-json 포맷의 raw JSON이 fallback history에 그대로 저장되던 버그. `extractResultTextFromStreamJson()`을 trigger-handler에서 적용하여 파싱된 텍스트만 저장.

### 2026-03-18: 워크트리 삭제 거짓 보고

`knownAuthPaths`가 비어있어 삭제 실패해도 서버에 "REMOVED"로 보고하던 버그. 실제 삭제 성공 시에만 보고하도록 수정. 근본 원인(authPath 미 persist)은 별도 플랜으로 분리.
