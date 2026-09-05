# Runner Permission Reference

## Runner별 권한 설정

| Runner          | CLI        | 권한 플래그                           | 샌드박스                                        |
| --------------- | ---------- | ------------------------------------- | ----------------------------------------------- |
| **Claude Code** | `claude`   | `--dangerously-skip-permissions`      | 전체 스킵                                       |
| **AMP**         | `ampcode`  | `--dangerously-allow-all`             | 전체 스킵                                       |
| **Codex**       | `codex`    | `CODEX_SANDBOX_LEVEL` 환경변수        | `workspace-write` (기본) 또는 `off`             |
| **OpenCode**    | `opencode` | 없음                                  | 없음                                            |
| **Cursor CLI**  | `agent`    | `--force`                             | 명시적으로 거부되지 않은 명령 자동 허용         |
| **Kimi CLI**    | `kimi`     | 없음 (`-p`의 auto 정책)               | 일반 tool 호출 자동 승인, 별도 우회 플래그 없음 |
| **Kiro CLI**    | `kiro-cli` | `--trust-all-tools`                   | 전체 스킵                                       |
| **Grok Build**  | `grok`     | `--permission-mode bypassPermissions` | 전체 스킵                                       |
| **Oh My Pi**    | `omp`      | `--auto-approve --approval-mode yolo` | 전체 스킵                                       |

Cursor CLI의 `--force`는 비대화형 실행 중 파일 변경과 셸 명령을 자동 승인합니다. 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다. Cursor 로그인 세션과 `CURSOR_API_KEY`는 Cursor가 관리하며 AgentTeams는 인증 값이나 `.cursor` 설정을 생성·변경하지 않습니다.

Kimi CLI는 `kimi -p <prompt>`를 사용해 비대화형으로 실행합니다. `-p` 모드의 일반 tool 호출은 Kimi의 `auto` 권한 정책으로 처리되며, `--yolo`, `--auto`, `--plan`을 함께 전달하지 않습니다. Kimi Code 로그인 세션은 Kimi가 관리하며 AgentTeams는 `.kimi` 설정이나 토큰을 생성·주입하지 않습니다. 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다.

Kiro CLI는 `kiro-cli chat --no-interactive --trust-all-tools -- <prompt>`로 실행합니다. `--trust-all-tools`는 모델이 확인 절차 없이 모든 도구(파일 쓰기·셸 명령 포함)를 실행하도록 허용하므로, Claude Code의 `--dangerously-skip-permissions`와 같은 등급의 권한 우회입니다. 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다. 프롬프트를 `--` 뒤에 두는 이유는 위치 인자라서 `-`로 시작하는 프롬프트가 플래그로 오인되기 때문입니다(실측).

Grok Build는 `grok --prompt-file <PATH> --cwd <PATH> --output-format streaming-messages-json --permission-mode bypassPermissions [-m <MODEL>]`로 실행합니다. `--permission-mode bypassPermissions`는 모델이 확인 절차 없이 모든 도구(파일 쓰기·셸 명령 포함)를 실행하도록 허용하므로, Claude Code의 `--dangerously-skip-permissions`, Kiro CLI의 `--trust-all-tools`와 같은 등급의 권한 우회입니다. 문서에 등장하는 `--yolo` 별칭은 이 빌드에 존재하지 않아 사용하지 않습니다(2026-08-14 실측, grok 1.0.3). 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다.

프롬프트를 `-p/--single`이 아니라 `--prompt-file`로 넘기는 이유는, `-`로 시작하는 프롬프트(러너 프롬프트는 항상 마크다운 불릿으로 시작)를 clap이 플래그로 오인해 `error: unexpected argument '- ' found`와 함께 exit 2로 종료하기 때문입니다(실측). 프롬프트 임시 파일은 `{authPath}/.agentteams/runner/tmp/{triggerId}.prompt.md`에 쓰고 실행 종료 시 제거합니다. 또한 자동 업데이트가 stdout NDJSON에 끼어들지 않도록 `GROK_DISABLE_AUTOUPDATER=1`을 주입합니다(이 빌드에는 `--no-auto-update` 플래그가 없습니다).

**AgentTeams는 Grok 인증 정보나 설정 파일을 생성·주입하지 않습니다.** Grok 로그인 세션은 Grok이 관리하며, 러너는 사용자가 이미 로그인한 세션(`~/.grok/auth.json`)을 그대로 사용합니다. `XAI_API_KEY`나 `~/.grok/**` 설정을 러너가 만들거나 수정하지 않습니다. 예외는 `agentteams` CLI의 MCP 등록(`grok mcp add`)뿐이며, 그 명령이 쓰는 설정 파일에 한정됩니다.

Oh My Pi는 `omp -p --no-session --auto-approve --approval-mode yolo --cwd <PATH> @<promptFile> [--model <MODEL>]`로 실행합니다(2026-08-24 실측, omp/18.0.4). `--auto-approve`와 `--approval-mode yolo`는 모델이 확인 절차 없이 모든 도구를 실행하도록 허용하므로 Claude Code의 `--dangerously-skip-permissions`와 같은 등급의 권한 우회입니다. 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다. 프롬프트를 `@file`로 넘기는 이유는, `-`로 시작하는 위치 인자를 clap이 플래그로 오인해 `Error: unknown flag`와 함께 exit 2로 종료하기 때문입니다. `--mode json`은 성공 스키마를 실측하지 못해 켜지 않으며, 로그는 ANSI만 제거합니다.

**AgentTeams는 Oh My Pi 인증 정보나 설정 파일을 생성·주입하지 않습니다.** omp 로그인 세션은 omp가 관리하며, 러너는 사용자가 이미 구성한 자격 증명(`ANTHROPIC_API_KEY` 등 또는 `~/.omp/agent`)을 그대로 사용합니다. 예외는 `agentteams` CLI의 MCP 등록(`~/.omp/agent/mcp.json` jsonMerge)뿐이며, 그 파일이 쓰는 설정에 한정됩니다.

**AgentTeams는 Kiro 인증 정보나 설정 파일을 생성·주입하지 않습니다.** Kiro 로그인 세션은 Kiro가 관리하며, 러너는 사용자가 이미 로그인한 세션을 그대로 사용합니다(2026-08-08 실측: `KIRO_API_KEY` 없이 `--no-interactive` 실행이 정상 동작). `KIRO_API_KEY`, `~/.kiro/**` 설정, `.kiro/agents/*.json`, `.kiro/steering/*.md`를 러너가 만들거나 수정하지 않습니다.

## 워크트리 설정 (`healWorktreeConfig`)

- `.agentteams` 심볼릭 링크: 원본 레포 → 워크트리
- `.env*` 파일: 원본 레포에서 워크트리로 **복사** (symlink 아님, Prisma 호환성)
- `settings.local.json`: 생성하지 않음 (`--dangerously-skip-permissions`로 불필요)

## 에이전트별 로그 수집 방식

| Runner          | stdout 포맷                                                         | 파싱                                                     | 로그 수집 방식                                                                                    |
| --------------- | ------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Claude Code** | stream-json (`--output-format stream-json`)                         | `createStreamJsonLineParser` → 구조화된 로그             | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록                                    |
| **AMP**         | stream-json (`--stream-json-thinking`)                              | `createStreamJsonLineParser` → 구조화된 로그             | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록                                    |
| **Codex**       | plain text                                                          | 없음 (raw output 그대로)                                 | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록                                             |
| **OpenCode**    | plain text                                                          | 없음 (raw output 그대로)                                 | raw stdout를 `onStdoutChunk`로 전달, logStream에 기록                                             |
| **Cursor CLI**  | stream-json (`--output-format stream-json --stream-partial-output`) | `createCursorStreamJsonLineParser` → bounded 구조화 로그 | assistant delta를 병합하고 안전한 tool 상태만 `onStdoutChunk`로 전달, raw를 logStream에 기록      |
| **Kimi CLI**    | plain text (`-p`)                                                   | 없음                                                     | raw stdout/stderr를 `onStdoutChunk`로 전달, logStream에 기록                                      |
| **Kiro CLI**    | plain text (`chat --no-interactive`)                                | 없음 (ANSI 이스케이프만 제거)                            | ANSI를 벗긴 stdout를 `onStdoutChunk`로 전달, raw를 logStream에 기록. stderr는 진행 로그 취급      |
| **Grok Build**  | stream-json (`--output-format streaming-messages-json`)             | `createStreamJsonLineParser` → 구조화된 로그             | 파싱된 메시지를 `onStdoutChunk`로 전달, raw를 logStream에 기록                                    |
| **Oh My Pi**    | plain text (`-p`)                                                   | 없음 (ANSI 이스케이프만 제거)                            | ANSI를 벗긴 stdout를 `onStdoutChunk`로 전달, raw를 logStream에 기록. stderr Node 경고는 진행 로그 |

### stream-json 파서 (`stream-json-parser.ts`)

Claude Code와 AMP의 stdout은 JSON lines 형식이며, 파서가 다음 타입을 처리:

- `system` — 세션 초기화 정보
- `assistant` — thinking, text, tool_use, tool_result
- `result` — 최종 완료 상태 (duration, turn count)

파서는 길이 제한을 적용: thinking 300자, text 500자, tool input 200자.

Kiro CLI는 구조화 출력 플래그가 없어 파서를 붙이지 않습니다. 다만 파이프(비-TTY)로 리다이렉트해도 ANSI 이스케이프가 남고 `NO_COLOR`·`TERM=dumb`으로도 완전히 제거되지 않으므로(2026-08-08 실측), `stripAnsiSequences`로 제어 문자만 제거한 뒤 `onStdoutChunk`와 fallback history용 `outputText`에 담습니다. stderr에는 정상 실행 중에도 신뢰 경고 배너와 종료 시 `▸ Credits: N • Time: Ns` 요약이 실리므로 에러가 아닌 진행 로그로 강등하며, 실패 사유를 고를 때는 진행 로그가 원인을 덮지 않도록 오류로 보이는 stderr 청크를 우선합니다.

Grok Build는 `--output-format streaming-messages-json`이 Anthropic Messages 와이어 포맷을 그대로 내보내므로 위 파서를 재사용합니다(2026-08-14 실측: 동일 프롬프트에서 `system:init` → `assistant(thinking,tool_use)` → `user(tool_result)` → `assistant(thinking,text)` → `result:success` 5줄). 네이티브 `--output-format streaming-json`은 같은 프롬프트에 63줄의 토큰 단위 `thought` 델타를 쏟아내 전용 파서가 필요하므로 선택하지 않았습니다. 다만 내장 도구 이름이 Claude Code와 달라(`read_file`·`write`·`search_replace`·`list_dir`·`grep`·`run_terminal_command`·`spawn_subagent`·`get_command_or_subagent_output`·`todo_write`) `summarizeToolUse`에 해당 이름과 입력 키를 추가했습니다. 기존 러너는 이 이름들을 내보내지 않으므로 동작이 바뀌지 않습니다.

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

## Muse Code

`muse exec --json --approval-mode never --prompt-file <PATH> [--model <ID>] [--reasoning-effort <LEVEL>]`

Muse Code는 승인과 샌드박스가 기본 활성화됩니다. 러너는 비대화형 실행을 위해 `--approval-mode never`로 승인만 해제하고 샌드박스를 유지합니다. `--yolo`는 승인과 샌드박스 보호를 해제하고 워크스페이스를 신뢰하므로 사용하지 않습니다. MCP 도구는 샌드박스 밖에서 실행되므로 신뢰하는 서버만 등록하고 격리된 RunnerBox/worktree를 사용하세요. 공식 설치 경로는 macOS/Linux이며 Windows 네이티브 설치는 지원되지 않습니다.

stdout은 MSP v1 JSONL입니다. 텍스트 델타, 성공 종단, 실패 사유를 정제하고 미실측 도구 이벤트는 원문을 보존합니다. 모델 목록은 `muse serve`의 initialize → initialized → model/list 순서로 조회합니다. 2026-09-05 실제 모델의 셸 도구 실행과 성공 종단을 확인했습니다. 도구 이벤트는 원문으로 유지합니다.
