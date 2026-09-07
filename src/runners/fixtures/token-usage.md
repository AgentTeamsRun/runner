# 실행별 토큰 사용량 계약

## 출처와 fixture

- Claude Code 2.1.260 (`claude --version`, 2026-09-06). [공식 사용량 계약](https://code.claude.com/docs/en/agent-sdk/cost-tracking): assistant 메시지 ID 중복 제거, result.usage는 현재 호출의 주 실행 루프 누적값이며 하위 에이전트 제외. assistant 출력 값은 placeholder이므로 최종 result 전에는 출력 토큰을 null로 둔다.
- OpenCode 1.18.18 (`opencode --version`), 소스 커밋 `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`. [출력 이벤트](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/cli/cmd/run.ts), [단계 사용량](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/processor.ts), [정규화](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/session.ts).
- Codex (codex-cli, 2026-09-07 확인). [Usage 구조체](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs): `turn.completed.usage`가 턴별 사용량을 싣고 세션 키는 `thread.started.thread_id`다. [포함 관계](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs): `non_cached_input() = input_tokens - cached_input_tokens`, `blended_total() = non_cached_input + output_tokens`이므로 입력은 캐시를 포함하고 출력은 추론을 포함한다. `fixtures/codex-events.jsonl`은 위 형식의 재구성 fixture다.
- omp 18.0.6 (2026-08-29 실측). assistant `message_end.message.usage`가 사용량을 싣고(`input`·`output`·`cacheRead`·`cacheWrite`·`totalTokens`·`reasoningTokens`), 세션 키는 `session` 이벤트의 최상위 `id`다. `input + cacheRead + output = totalTokens` 항등식이 성립하므로 `reasoningTokens`은 별도 가산하지 않는다. `fixtures/omp-events.jsonl`(성공 4턴)과 `fixtures/omp-events-error.jsonl`(401 실패)은 verbatim 캡처다.
- JSONL은 위 공식 형식에서 사용량 필드만 남기고 식별자와 수치를 고정한 재구성 fixture다. 실제 유료 실행 캡처라고 주장하지 않는다. 원문 프롬프트·응답·도구 입력을 포함하지 않는다. 중복 행은 재전송 검증을 위해 의도적으로 추가했다.

## 정규화 표

| 필드                     | Claude                                           | OpenCode                                                      | Codex                                                             | omp                                                                                        |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| inputTokens              | input_tokens (캐시 제외)                         | tokens.input (캐시 제외)                                      | input_tokens − cached_input_tokens (입력은 캐시 포함이므로 차감)  | usage.input                                                                                |
| outputTokens             | 최종 usage.output_tokens                         | tokens.output + tokens.reasoning (1.18.18의 출력은 추론 제외) | usage.output_tokens (추론 포함이므로 가산 없음)                   | usage.output (reasoningTokens 가산 없음)                                                   |
| cacheReadInputTokens     | cache_read_input_tokens                          | tokens.cache.read                                             | cached_input_tokens                                               | usage.cacheRead                                                                            |
| cacheCreationInputTokens | cache_creation_input_tokens                      | tokens.cache.write                                            | 대응 필드 없어 null (신버전 cache_write_input_tokens 있으면 읽음) | usage.cacheWrite                                                                           |
| 범위                     | 현재 호출 주 실행 루프                           | 현재 호출 주 세션의 단계                                      | 턴별 turn.completed 합산                                          | assistant message_end 합산                                                                 |
| 중복 제거                | session_id + message.id; result는 합산 없이 교체 | sessionID + part.id별 교체 후 단계 합산                       | thread_id + 합성 순번; id가 없어 중복 행을 제거할 수 없다         | session id + 합성 순번; message.id가 null이라 중복 행을 제거할 수 없다                     |
| 종료 근거                | result 이벤트                                    | step-finish reason stop                                       | turn.completed                                                    | 마지막 assistant message_end stopReason stop (turn_end 중복 제외, agent_end는 사용량 없음) |

입력에 캐시를 다시 포함하지 않는다. 전체 트리 사용량이나 비용을 의미하지 않는다. 필드 누락·음수·비정수·안전 정수 초과는 null이며 실제 0은 보존한다. 알 수 없는 이벤트는 무시한다. 사용량 수집은 실행 성공/실패/취소 상태를 변경하지 않는다. Codex 다중 턴이 누적값인지 턴별값인지는 fixture 단일 턴만으로 확정할 수 없어, 구조체 주석("during a turn")을 근거로 턴별 합산으로 해석한다.

## 수집 상태와 경계

- COMPLETE: 주 실행 루프의 종료 근거와 보고 가능 필드가 모두 있다. 보고 가능 집합은 엔진별로 다르다(Claude·OpenCode·omp는 네 필드 전부, Codex는 cacheCreation 제외). 실패 결과도 최종 사용량이 온전하면 COMPLETE일 수 있다.
- Codex는 cacheCreation 대응 필드가 없어 null이며 COMPLETE 판정에서 제외한다.
- omp는 메시지 id가 없어 중복 행을 제거할 수 없다. 순번 합성 키는 매 행을 별도 단계로 쌓는다.
- 세션 키 출처는 엔진별로 다르다(Claude는 사용량 이벤트의 session_id, OpenCode는 sessionID, Codex는 thread.started.thread_id, omp는 session id). 사용량 이벤트와 세션 이벤트가 다를 수 있어, 세션을 아직 못 본 사용량 이벤트를 버리지 않는다. 세션 불일치가 실제로 관측될 때만 수치를 비운다.
- Claude result 누적값이 온전하면 앞선 행 유실을 대체한다. OpenCode step-finish는 단계별 값이므로 행 유실·단계 상한 초과는 최종 stop 이후에도 PARTIAL이다. Codex·omp 합성 키 단계도 행 유실 시 PARTIAL이다. 오류 이벤트 자체는 수치 유실을 의미하지 않는다.
- PARTIAL: 일부 사용량만 있거나 종료 근거가 없다. 취소·시간초과 시 기존 수치는 보존한다.
- MISSING: 지원 엔진이지만 유효한 사용량이 없다. 네 값은 null이다.
- UNSUPPORTED: `RUNNER_CAPABILITIES.tokenUsage`가 false인 엔진. 현재 CLAUDE_CODE·OPENCODE·CODEX·OMP 외 전부. 네 값은 null이다.
- 기존 데이터의 snapshot null은 수집 도입 전/보고 없음이다. MISSING과 0으로 변환하지 않는다.
- attempt는 DaemonTrigger.id다. continue 경로는 새 ID를 만들고 parentTriggerId로 연결한다. claim은 PENDING에서 RUNNING으로 원자 전환하며 동일 트리거를 다시 claim하지 않는다. 세션 ID는 관측 범위 확인용이며 재시도 키로 쓰지 않는다.
- 저장은 트리거당 nullable snapshot 1개를 교체하며 덧셈하지 않는다. 부모 트리거 삭제·보존 정책을 그대로 상속하므로 독립 보존 작업은 불필요하다.

## 기대값

- claude-usage.jsonl: 중복 assistant와 result를 포함해도 입력 150, 출력 40, 캐시 읽기 50, 캐시 생성 10, COMPLETE. 첫 세 행만 처리하면 입력 150, 출력 null, 캐시 읽기 50, 캐시 생성 10, PARTIAL.
- opencode-usage.jsonl: 중복 단계를 포함해도 입력 150, 출력 40(추론 10 포함), 캐시 읽기 50, 캐시 생성 10, COMPLETE. 첫 두 행만 처리하면 100/15/20/10, PARTIAL.
- codex-events.jsonl: 전체를 흘려보내면 입력 21099(= 78699 − 57600), 출력 292(추론 15 포함이므로 가산 없음), 캐시 읽기 57600, 캐시 생성 null, COMPLETE. 첫 행(thread.started)만 넣으면 MISSING이고 네 값이 null이다.
- omp-events.jsonl: assistant message_end 4건의 합으로 입력 13165, 출력 253, 캐시 읽기 71680, 캐시 생성 0, COMPLETE. 출력 합은 4건 output 값의 단순 합(191+29+24+9)과 같고 reasoningTokens(103)는 더하지 않는다. user·toolResult message_end와 message_start, turn_end 중복은 집계하지 않는다.
- 빈 스트림은 MISSING; 지원 외 엔진은 UNSUPPORTED; 네 필드가 실제 0인 종료 이벤트는 COMPLETE와 0을 유지한다.
- 새 트리거의 수집기는 이전 호출 값을 상속하지 않는다. 세션 불일치가 발생하면 어느 세션이 주 실행인지 확정할 수 없으므로 수치를 비우고 MISSING으로 표시한다.
