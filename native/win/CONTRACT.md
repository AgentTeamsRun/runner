## Windows 네이티브 런처 계약

Runner의 예약 작업과 웹 재시작 helper는 콘솔 서브시스템인 `powershell.exe`를 직접
시작하지 않습니다. 대신 C로 작성하고 MSVC x64 `/MT /SUBSYSTEM:WINDOWS`로 링크한
`agentrunner-launcher.exe`를 첫 프로세스로 사용합니다.

- 진입점은 Unicode `wWinMain`입니다.
- 런처는 자신의 실행 파일 뒤 raw command-line tail을 쓰기 가능한 버퍼로 복사하고
  `CreateProcessW`에 전달합니다. 호출자는 argv[0]과 자식 command line 사이에
  `--exec` 구분자를 넣으며, 런처는 이 구분자 뒤를 tail로 사용합니다. 구분자가
  없으면 `GetModuleFileNameW(NULL)`로 얻은 자기 경로 길이로 argv[0]을 건너뛰므로,
  Task Scheduler가 `<Command>`를 따옴표 없이 넣고 프로필 경로에 공백이 있어도
  (`C:\Users\John Doe\...`) 자식 command line이 잘리지 않습니다.
- 자식 실행 파일은 항상 절대 경로
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`로 지정하며,
  예약 작업 XML은 `<WorkingDirectory>`도 같은 디렉터리로 고정합니다. 무결성 검증된
  런처가 실행 파일 검색 순서에 의존해 첫 자식을 고르지 않도록 하기 위함입니다.
- 자식 생성 플래그는 `CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`이며
  `bInheritHandles=FALSE`입니다. `--kill-tree-on-exit` 모드에서만
  `CREATE_SUSPENDED`가 추가됩니다.
- `DETACHED_PROCESS`와 `CREATE_BREAKAWAY_FROM_JOB`은 사용하지 않습니다. 예약 작업의
  Job 감독과 `/End`, `IgnoreNew`, `RestartOnFailure` 의미를 유지해야 합니다.
  `--kill-tree-on-exit`의 중첩 Job은 breakaway가 아니라 Task Scheduler Job
  안에서 손자까지 포함하는 하위 Job이므로 이 금지와 충돌하지 않습니다.
- 런처는 자식을 무기한 기다린 뒤 자식 종료 코드를 그대로 반환하고 모든 handle과
  할당 메모리를 해제합니다.
- 인수가 없거나 자식 생성·대기·종료 코드 조회가 실패하면 비밀값을 포함하지 않는
  Windows Event Log 진단과 0이 아닌 종료 코드를 남깁니다.
- 배포 산출물은 `native/bin/win32-x64/`에 생성하며 최종 exe 바이트의 SHA-256,
  패키지 버전, platform/architecture/file name을 `manifest.json`에 기록합니다.
- 설치 시 manifest와 package exe를 검증하고
  `%USERPROFILE%\.agentteams\bin\agentrunner-launcher-<version>-<sha12>.exe`로
  원자 복사합니다. 누락·불일치·지원하지 않는 환경에서는 PowerShell 직접 실행으로
  fallback하지 않습니다.
- 설치가 성공하면 같은 디렉터리의 이전 버전 런처와 중단된 `.<pid>.tmp` 잔재를
  즉시 정리합니다(uninstall은 현재 런처까지 포함해 전부 제거).
- `native/bin/win32-x64/`에는 `agentrunner-launcher.exe`와 `manifest.json`만
  존재해야 하며, `verify-packed-package.mjs`가 source와 npm tarball 해제본 모두에
  이를 강제합니다. Windows CI는 같은 계약을 PowerShell 5/7에서 실행하고,
  GitHub-hosted runner에서만 `verify-lifecycle.ps1`로 설치·예약 작업·정리 수명주기를
  검증합니다. 스모크
  픽스처는 배포 디렉터리가 아니라 빌드 임시 디렉터리에 만듭니다.
- 지원 대상은 Windows x64와 x64 에뮬레이션을 제공하는 Windows 11 ARM64입니다.
  Windows 10 ARM64는 지원하지 않습니다.

### `--kill-tree-on-exit` 트리 정리 모드 (옵트인)

- 사용법: `<launcher> --kill-tree-on-exit --exec <자식 command line>`.
  플래그는 argv[0] 바로 뒤 첫 토큰이어야 하며 `--exec` 구분자가 뒤에 있을
  때만 인식합니다. 구분자 없는 bare 자식 명령이 같은 토큰으로 시작해도
  플래그로 오인하지 않습니다.
- 플래그가 없으면 자식 생성 경로는 이전과 바이트 단위로 동일합니다
  (`CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`, Job 호출 없음).
- 모드가 켜지면 `CreateJobObjectW` → `SetInformationJobObject`
  (`JobObjectExtendedLimitInformation`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
  → `CreateProcessW(... | CREATE_SUSPENDED)` → `AssignProcessToJobObject`
  → `ResumeThread` 순서로 실행합니다. 자식은 한 명령도 실행하기 전에 Job에
  들어가므로, 실행된 자식이 Job 밖에 있는 경우는 없습니다.
- Job handle은 자식 종료 대기 후까지 열어 둡니다. 런처가 먼저 죽으면
  (`schtasks /End`가 직접 자식을 끝내는 경우) 마지막 handle이 닫히면서
  `KILL_ON_JOB_CLOSE`가 자식·손자 전체를 정리합니다. 정상 종료 시에는
  자식 종료 코드를 그대로 반환하지만, 이때도 마지막 handle이 닫히므로
  자식보다 오래 살아남은 손자는 함께 정리됩니다. 모드가 켜진 경로에서는
  자식 종료 뒤에 살아남는 프로세스에 의존하지 마세요.
- 실패 시 동작(조용히 Job 없이 계속하지 않음):
  - Job 생성·설정 실패 → 자식을 만들지 않고 Event Log 진단 후 종료 코드 73.
  - Job 할당 실패 → 중단된 자식을 `TerminateProcess`로 끝내고(실행 없이
    종료) Event Log 진단 후 종료 코드 74.
  - 자식 재개 실패 → 중단된 자식을 `TerminateProcess`로 끝내고 Event Log
    진단 후 종료 코드 75.
  - 자식 생성 실패 → 기존과 동일하게 원시 오류 코드를 반환합니다.
- `smoke.ps1`은 동일 소스를 테스트 전용
  `AGENTRUNNER_TEST_FORCE_JOB_ASSIGN_FAILURE` 정의와 함께 별도 빌드해 Job 할당
  실패 분기를 결정적으로 실행합니다. 이 바이너리는 임시 빌드 디렉터리에만
  생성하고 배포 산출물에는 포함하지 않습니다.
- 경로별 사용 여부:
  - 예약 작업 액션 = 켬 (`autostart.ts`가 작업 XML 인수에 추가).
  - 웹 재시작 helper(`Invoke-CimMethod`의 `restartCommandLine`) = 끔.
    helper 종료와 함께 direct fallback 러너가 죽으면 안 되기 때문입니다.
  - 수동 실행·미등록 fallback = 끔.
- Windows 8 이상이 지원하는 중첩 Job에 의존합니다. Task Scheduler Job
  안에서 중첩 Job 생성·할당이 동작함은 격리 예약 작업에서 실측했습니다.

현재 경로 판정:

| 경로                   | 기존 첫 프로세스             | 결함/특성                                                                  | 목표                           |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| Task Scheduler action  | `powershell.exe`             | 콘솔 프로세스를 직접 생성                                                  | content-addressed GUI launcher |
| Web restart WMI helper | `powershell.exe`             | Job 밖 복구 helper지만 콘솔 프로세스를 직접 생성                           | WMI가 GUI launcher 생성        |
| 미등록 fallback        | Node `spawn(powershell.exe)` | `windowsHide: true`, `stdio: ignore`, detached 없음으로 `CREATE_NO_WINDOW` | 기존 경로 유지                 |
