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

Grok Build는 `grok --prompt-file <PATH> --cwd <PATH> --output-format streaming-messages-json --permission-mode bypassPermissions [-m <MODEL>] [--reasoning-effort <LEVEL>]`로 실행합니다. `--permission-mode bypassPermissions`는 모델이 확인 절차 없이 모든 도구(파일 쓰기·셸 명령 포함)를 실행하도록 허용하므로, Claude Code의 `--dangerously-skip-permissions`, Kiro CLI의 `--trust-all-tools`와 같은 등급의 권한 우회입니다. 문서에 등장하는 `--yolo` 별칭은 이 빌드에 존재하지 않아 사용하지 않습니다(2026-08-14 실측, grok 1.0.3). 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다.

프롬프트를 `-p/--single`이 아니라 `--prompt-file`로 넘기는 이유는, `-`로 시작하는 프롬프트(러너 프롬프트는 항상 마크다운 불릿으로 시작)를 clap이 플래그로 오인해 `error: unexpected argument '- ' found`와 함께 exit 2로 종료하기 때문입니다(실측). 프롬프트 임시 파일은 `{authPath}/.agentteams/runner/tmp/{triggerId}.prompt.md`에 쓰고 실행 종료 시 제거합니다. 또한 자동 업데이트가 stdout NDJSON에 끼어들지 않도록 `GROK_DISABLE_AUTOUPDATER=1`을 주입합니다(이 빌드에는 `--no-auto-update` 플래그가 없습니다).

**AgentTeams는 Grok 인증 정보나 설정 파일을 생성·주입하지 않습니다.** Grok 로그인 세션은 Grok이 관리하며, 러너는 사용자가 이미 로그인한 세션(`~/.grok/auth.json`)을 그대로 사용합니다. `XAI_API_KEY`나 `~/.grok/**` 설정을 러너가 만들거나 수정하지 않습니다. 예외는 `agentteams` CLI의 MCP 등록(`grok mcp add`)뿐이며, 그 명령이 쓰는 설정 파일에 한정됩니다.

Oh My Pi는 `omp -p --no-session --auto-approve --approval-mode yolo --cwd <PATH> @<promptFile> [--model <MODEL>] [--thinking <LEVEL>]`로 실행합니다(2026-08-24 실측, omp/18.0.4. `--thinking`은 2026-09-06 실측, omp/18.1.2). `--auto-approve`와 `--approval-mode yolo`는 모델이 확인 절차 없이 모든 도구를 실행하도록 허용하므로 Claude Code의 `--dangerously-skip-permissions`와 같은 등급의 권한 우회입니다. 신뢰할 수 있는 workspace에서만 사용하고, 가능하면 RunnerBox 또는 worktree로 실행 범위를 격리합니다. 프롬프트를 `@file`로 넘기는 이유는, `-`로 시작하는 위치 인자를 clap이 플래그로 오인해 `Error: unknown flag`와 함께 exit 2로 종료하기 때문입니다. `--mode json`은 성공 스키마를 실측하지 못해 켜지 않으며, 로그는 ANSI만 제거합니다.

**AgentTeams는 Oh My Pi 인증 정보나 설정 파일을 생성·주입하지 않습니다.** omp 로그인 세션은 omp가 관리하며, 러너는 사용자가 이미 구성한 자격 증명(`ANTHROPIC_API_KEY` 등 또는 `~/.omp/agent`)을 그대로 사용합니다. 예외는 `agentteams` CLI의 MCP 등록(`~/.omp/agent/mcp.json` jsonMerge)뿐이며, 그 파일이 쓰는 설정에 한정됩니다.

**AgentTeams는 Kiro 인증 정보나 설정 파일을 생성·주입하지 않습니다.** Kiro 로그인 세션은 Kiro가 관리하며, 러너는 사용자가 이미 로그인한 세션을 그대로 사용합니다(2026-08-08 실측: `KIRO_API_KEY` 없이 `--no-interactive` 실행이 정상 동작). `KIRO_API_KEY`, `~/.kiro/**` 설정, `.kiro/agents/*.json`, `.kiro/steering/*.md`를 러너가 만들거나 수정하지 않습니다.

## 실행 옵션: 추론 강도(Effort)

러너는 요청의 `effort` 값을 어휘 검증 없이 각 CLI의 플래그로 그대로 전달합니다. 빈 값이면 플래그를 생략해 CLI 기본값을 따르고, 비어 있지 않으면 정확히 한 번 전달합니다(POSIX·PowerShell 양쪽). 검증은 API 한 곳에서만 합니다 — 엔진 허용 집합(`packages/core-constants`의 `RUNNER_EFFORT_LEVELS`)과 모델별 `supportedEffortLevels`의 **교집합**에 있는 값만 생성·이어하기·resolve-settings를 통과합니다. 모델을 고르지 않은 요청(클라이언트 기본값)에는 effort를 붙일 수 없습니다. CLI가 무효값을 거부한다고 가정하지 마세요 — Claude Code와 omp는 무효값을 경고만 남기고 기본값으로 무음 대체합니다(아래 표).

`capabilities.effort`와 `RUNNER_EFFORT_LEVELS`는 `scripts/runner-capability-contract.test.mjs`가 1:1로 대조하므로 새 엔진은 반드시 같은 커밋에서 둘 다 켭니다. 모델별 레벨은 `model-enumerator`가 카탈로그에서 읽을 수 있는 엔진만 자동 수집하고(DETECTED 행은 탐지 주기마다 갱신, 사용자가 편집한 MANUAL 행은 덮어쓰지 않음), 나머지는 모델 관리 화면의 수동 설정 경로입니다. 카탈로그에 없는 값은 API 수집 필터가 항목별로 버리며, 미확인 모델을 엔진 전체 집합으로 채우지 않습니다. 모델 id 자체에 레벨이 박힌 엔진(Antigravity)은 daemon이 effort 어휘 사본을 두지 않는다는 원칙에 따라 API의 `syncDetectedMemberRunnerModels`가 id에서 레벨을 파생합니다.

러너는 사용자가 개별 설치·갱신하므로 새 엔진의 effort 전달이 도달하기까지 전환 기간이 깁니다. 구버전 러너의 trigger handler는 `capabilities.effort=false`라 서버가 확정한 값을 경고 한 줄만 남기고 버린 뒤 CLI 기본 강도로 실행하므로, API가 대상 러너의 `runnerVersion`을 `packages/core-constants`의 `RUNNER_EFFORT_MIN_RUNNER_VERSION`과 대조해 요청 단계에서 거절합니다(`RUNNER_EFFORT_RUNNER_VERSION_TOO_OLD`). 표에 없는 엔진(Codex·Claude Code·Muse Code)은 러너 도입기부터 전달했으므로 게이트하지 않고, 버전을 보고하지 않은 러너는 막지 않습니다. **새 엔진에 effort를 붙이면 그 변경이 실제로 실리는 러너 릴리스 버전을 그 표에 함께 추가합니다.**

### 지원 매트릭스 (2026-09-06~07, macmini 설치판 실측 + 공식 문서)

| 엔진(최소 확인 버전)                  | 판정                     | 전달 플래그                           | 허용 집합                                     | 모델별 레벨 출처                                                                                                            | 무효값 동작                                                                      | 근거·미확인                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------ | ------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex** (codex-cli 0.153.2)         | 지원                     | `-c model_reasoning_effort="<level>"` | minimal, low, medium, high, xhigh, max, ultra | 자동 — `codex debug models`의 `supported_reasoning_levels`(숨김 항목 제외)                                                  | 설정 오버라이드라 CLI 단계 검증 없음 → 서버 검증이 게이트                        | `minimal`은 현재 카탈로그 어느 모델에도 없으나 문서 근거로 유지                                                                                                                                                                 |
| **Claude Code** (2.1.260)             | 지원                     | `--effort <level>`                    | low, medium, high, xhigh, max                 | 수동 — 모델 열거 없음. 공식 문서: Fable 5.1/5·Opus 5·Sonnet 5·Opus 4.8/4.7 low~max, Opus 4.6·Sonnet 4.6 low/medium/high/max | **경고 후 기본값으로 무음 대체**(`Warning: Unknown --effort value ... ignoring`) | 요청에 effort가 있으면 `CLAUDE_CODE_EFFORT_LEVEL` 환경변수를 제거해 플래그가 이기게 한다                                                                                                                                        |
| **Muse Code** (1.0.3)                 | 지원                     | `exec --reasoning-effort <level>`     | minimal, low, medium, high, xhigh, max, ultra | 자동 — MSP `model/list`에 레벨 필드가 없어 기본 공급자(`meta`) 모델에만 실측 집합을 보완, 다른 공급자는 빈 목록             | CLI 거부(exit 2, `unsupported reasoning effort`)                                 | 도움말의 `none`은 기본 공급자에서 exit 2로 거부돼 제외(4모델×8레벨 32회 실행)                                                                                                                                                   |
| **OpenCode** (1.18.18)                | 조건부 지원              | `run --variant <name>`                | none, minimal, low, medium, high, xhigh, max  | 자동 — `opencode models --verbose`의 모델별 `variants` 키(382건 중 178건 보유). `variants: {}`·키 없음은 빈 목록            | **미실측**(유료 실행 필요)                                                       | `thinking`처럼 effort 어휘 밖 variant 이름은 수집 단계에서 버림. `--thinking`은 표시 토글이라 대상 아님                                                                                                                         |
| **Antigravity** (agy 1.1.27)          | 조건부 지원              | `--effort <level>`(세션 단위)         | low, medium, high                             | 자동 — `agy models` id의 레벨 접미사(`gemini-3.8-flash-high` 등)에서 그 레벨 하나만 파생. 접미사가 없는 id는 빈 목록        | CLI 거부(exit 1, valid low/medium/high 안내)                                     | 접미사 모델에 다른 레벨을 주면 `conflicts with --effort=<level>`로 exit 1 — 파생은 `syncDetectedMemberRunnerModels`, 충돌 거절은 `validateSupportedEffortLevelsInput`·`ensureEffortSelectionAllowed`가 맡는다. 무음 우선은 없음 |
| **Copilot CLI** (1.0.83)              | 지원(엔진 수준)          | `--effort <level>`                    | none, minimal, low, medium, high, xhigh, max  | 수동 — 모델 열거 없음, 공식 레퍼런스에 모델별 레벨 미기재                                                                   | CLI 거부                                                                         | 모델별 레벨 미확정                                                                                                                                                                                                              |
| **Oh My Pi** (18.1.2)                 | 조건부 지원              | `--thinking <level>`                  | minimal, low, medium, high, xhigh, max        | 자동 — `omp models --json`의 모델별 `thinking` 배열. `null`/비배열은 빈 목록. `reasoning` boolean은 레벨 출처가 아님        | **무음 대체**(`--thinking bogus`가 exit 0으로 기본값 실행)                       | `--thinking`의 `off`/`auto`는 레벨이 아니라 끄기·위임 스위치라 제외. `--hide-thinking`은 표시 전용                                                                                                                              |
| **Grok Build** (1.0.13)               | 지원                     | `--reasoning-effort <level>`          | low, medium, high, xhigh                      | 수동 — `grok models` 목록에 레벨 필드 없음                                                                                  | CLI 거부(exit 1, 허용값 안내)                                                    | grok-4.6 + low 실제 실행에서 ACP `session/set_model`의 `_meta.reasoningEffort`와 응답 메타데이터 적용 확인. x.ai 문서상 grok-4.5는 xhigh를 high로 무음 강등하므로 그 모델 메타데이터에 xhigh를 넣지 말 것                       |
| **Kiro CLI** (2.21.1)                 | 미지원                   | 전달하지 않음                         | —                                             | —                                                                                                                           | `--effort bogus`는 clap 단계 무음 통과                                           | 공식 문서(kiro.dev/docs/models/effort)상 `chat --effort`가 `~/.kiro/settings/cli.json`에 자동 저장됨 → 사용자 전역 설정 변경 금지 원칙과 충돌. 실행 단위 경로가 확인될 때까지 미지원. 토큰 사용량 비교는 판정 근거로 쓰지 않음  |
| **Kimi CLI** (문서 근거, 설치본 없음) | 미지원                   | 전달하지 않음                         | —                                             | —                                                                                                                           | —                                                                                | 현행 `kimi -p` 레퍼런스에 effort·thinking 플래그 없음. 설정 파일 `[thinking] effort`와 모델별 `support_efforts`만 존재해 실행 단위 전달 경로가 사용자 설정 파일 수정뿐 → 채택 불가. **미확인**: 설치본으로의 `--help` 실측      |
| **Cursor CLI** (2026.08.25)           | 미지원(모델 축으로 대체) | 전달하지 않음                         | —                                             | —                                                                                                                           | —                                                                                | `cursor-agent models` id에 레벨이 내장(`gpt-5.3-codex-high`, `claude-opus-5-low` 등). `--help`의 `--model 'name[effort=high]'` 괄호 문법은 공식 문서 어디에도 없어 **미확인** — 사용자는 접미사 모델을 고른다                   |
| **Amp** (0.0.1786715939)              | 미지원(mode에 내장)      | 전달하지 않음                         | —                                             | —                                                                                                                           | —                                                                                | `-m/--mode` low/medium/high/ultra가 모델·effort·프롬프트를 묶는다. 프로젝트는 이미 `model`→`--mode`로 전달                                                                                                                      |

Windows는 생성된 PowerShell 명령을 검증했고 실제 Windows CLI 실행은 하지 않았습니다. OpenCode의 무효 variant 런타임 동작과 Kimi 설치본 실측은 남아 있는 확인 항목입니다.

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
