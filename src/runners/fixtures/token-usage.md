# 실행별 토큰 사용량 계약

## 출처와 fixture

- Claude Code 2.1.260 (`claude --version`, 2026-09-06). [공식 사용량 계약](https://code.claude.com/docs/en/agent-sdk/cost-tracking): assistant 메시지 ID 중복 제거, result.usage는 현재 호출의 주 실행 루프 누적값이며 하위 에이전트 제외. assistant 출력 값은 placeholder이므로 최종 result 전에는 출력 토큰을 null로 둔다.
- OpenCode 1.18.18 (`opencode --version`), 소스 커밋 `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`. [출력 이벤트](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/cli/cmd/run.ts), [단계 사용량](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/processor.ts), [정규화](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/session.ts).
- JSONL은 위 공식 형식에서 사용량 필드만 남기고 식별자와 수치를 고정한 재구성 fixture다. 실제 유료 실행 캡처라고 주장하지 않는다. 원문 프롬프트·응답·도구 입력을 포함하지 않는다. 중복 행은 재전송 검증을 위해 의도적으로 추가했다.

## 정규화 표

| 필드                     | Claude                                           | OpenCode                                                      |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| inputTokens              | input_tokens (캐시 제외)                         | tokens.input (캐시 제외)                                      |
| outputTokens             | 최종 usage.output_tokens                         | tokens.output + tokens.reasoning (1.18.18의 출력은 추론 제외) |
| cacheReadInputTokens     | cache_read_input_tokens                          | tokens.cache.read                                             |
| cacheCreationInputTokens | cache_creation_input_tokens                      | tokens.cache.write                                            |
| 범위                     | 현재 호출 주 실행 루프                           | 현재 호출 주 세션의 단계                                      |
| 중복 제거                | session_id + message.id; result는 합산 없이 교체 | sessionID + part.id별 교체 후 단계 합산                       |

입력에 캐시를 다시 포함하지 않는다. 전체 트리 사용량이나 비용을 의미하지 않는다. 필드 누락·음수·비정수·안전 정수 초과는 null이며 실제 0은 보존한다. 알 수 없는 이벤트는 무시한다. 사용량 수집은 실행 성공/실패/취소 상태를 변경하지 않는다.

## 수집 상태와 경계

- COMPLETE: 주 실행 루프의 종료 근거와 네 수치가 모두 있다. 실패 결과도 최종 사용량이 온전하면 COMPLETE일 수 있다.
- Claude result 누적값이 온전하면 앞선 행 유실을 대체한다. OpenCode step-finish는 단계별 값이므로 행 유실·단계 상한 초과는 최종 stop 이후에도 PARTIAL이다. 오류 이벤트 자체는 수치 유실을 의미하지 않는다.
- PARTIAL: 일부 사용량만 있거나 종료 근거가 없다. 취소·시간초과 시 기존 수치는 보존한다.
- MISSING: 지원 엔진이지만 유효한 사용량이 없다. 네 값은 null이다.
- UNSUPPORTED: Claude/OpenCode 외 엔진. 네 값은 null이다.
- 기존 데이터의 snapshot null은 수집 도입 전/보고 없음이다. MISSING과 0으로 변환하지 않는다.
- attempt는 DaemonTrigger.id다. continue 경로는 새 ID를 만들고 parentTriggerId로 연결한다. claim은 PENDING에서 RUNNING으로 원자 전환하며 동일 트리거를 다시 claim하지 않는다. 세션 ID는 관측 범위 확인용이며 재시도 키로 쓰지 않는다.
- 저장은 트리거당 nullable snapshot 1개를 교체하며 덧셈하지 않는다. 부모 트리거 삭제·보존 정책을 그대로 상속하므로 독립 보존 작업은 불필요하다.

## 기대값

- claude-usage.jsonl: 중복 assistant와 result를 포함해도 입력 150, 출력 40, 캐시 읽기 50, 캐시 생성 10, COMPLETE. 첫 세 행만 처리하면 입력 150, 출력 null, 캐시 읽기 50, 캐시 생성 10, PARTIAL.
- opencode-usage.jsonl: 중복 단계를 포함해도 입력 150, 출력 40(추론 10 포함), 캐시 읽기 50, 캐시 생성 10, COMPLETE. 첫 두 행만 처리하면 100/15/20/10, PARTIAL.
- 빈 스트림은 MISSING; 지원 외 엔진은 UNSUPPORTED; 네 필드가 실제 0인 종료 이벤트는 COMPLETE와 0을 유지한다.
- 새 트리거의 수집기는 이전 호출 값을 상속하지 않는다. 세션 불일치가 발생하면 어느 세션이 주 실행인지 확정할 수 없으므로 수치를 비우고 MISSING으로 표시한다.
