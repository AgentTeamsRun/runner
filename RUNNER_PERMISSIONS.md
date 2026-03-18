# Runner Permission Reference

## Runner별 권한 설정

| Runner | CLI | 권한 플래그 | 샌드박스 |
|---|---|---|---|
| **Claude Code** | `claude` | `--dangerously-skip-permissions` | 전체 스킵 |
| **AMP** | `ampcode` | `--dangerously-allow-all` | 전체 스킵 |
| **Codex** | `codex` | `CODEX_SANDBOX_LEVEL` 환경변수 | `workspace-write` (기본) 또는 `off` |
| **Gemini** | `gemini` | `-y` (auto-approve) | 없음 |
| **OpenCode** | `opencode` | 없음 | 없음 |

## 워크트리 설정 (`healWorktreeConfig`)

- `.agentteams` 심볼릭 링크: 원본 레포 → 워크트리
- `.env*` 파일: 원본 레포에서 워크트리로 **복사** (symlink 아님, Prisma 호환성)
- `settings.local.json`: 생성하지 않음 (`--dangerously-skip-permissions`로 불필요)

## 에이전트별 로그 수집 방식

| Runner | stdout 포맷 | 파싱 | 로그 수집 방식 |
|---|---|---|---|
| **Claude Code** | stream-json (`--output-format stream-json`) | `createStreamJsonLineParser` → 구조화된 로그 | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록 |
| **AMP** | stream-json (`--stream-json-thinking`) | `createStreamJsonLineParser` → 구조화된 로그 | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록 |
| **Codex** | plain text | 없음 (raw output 그대로) | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록 |
| **Gemini** | plain text | 없음 (raw output 그대로) | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록 |
| **OpenCode** | plain text | 없음 (raw output 그대로) | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록 |

### stream-json 파서 (`stream-json-parser.ts`)

Claude Code와 AMP의 stdout은 JSON lines 형식이며, 파서가 다음 타입을 처리:
- `system` — 세션 초기화 정보
- `assistant` — thinking, text, tool_use, tool_result
- `result` — 최종 완료 상태 (duration, turn count)

파서는 길이 제한을 적용: thinking 300자, text 500자, tool input 200자.

### 로그 흐름 (공통)

```
runner stdout ──┬── logStream (raw) ──→ .agentteams/runner/log/{triggerId}.log
                │
                ├── streamParser (Claude Code/AMP만) ──→ onStdoutChunk (파싱된 메시지)
                │   또는 raw output (Codex/Gemini/OpenCode) ──→ onStdoutChunk
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
