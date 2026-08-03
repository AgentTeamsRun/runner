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
  `bInheritHandles=FALSE`입니다.
- `DETACHED_PROCESS`와 `CREATE_BREAKAWAY_FROM_JOB`은 사용하지 않습니다. 예약 작업의
  Job 감독과 `/End`, `IgnoreNew`, `RestartOnFailure` 의미를 유지해야 합니다.
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
  이를 강제합니다. Windows CI는 같은 계약을 PowerShell 5/7에서 실행하고
  `verify-lifecycle.ps1`만으로 설치·예약 작업·정리 수명주기를 검증합니다. 스모크
  픽스처는 배포 디렉터리가 아니라 빌드 임시 디렉터리에 만듭니다.
- 지원 대상은 Windows x64와 x64 에뮬레이션을 제공하는 Windows 11 ARM64입니다.
  Windows 10 ARM64는 지원하지 않습니다.

현재 경로 판정:

| 경로                   | 기존 첫 프로세스             | 결함/특성                                                                  | 목표                           |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| Task Scheduler action  | `powershell.exe`             | 콘솔 프로세스를 직접 생성                                                  | content-addressed GUI launcher |
| Web restart WMI helper | `powershell.exe`             | Job 밖 복구 helper지만 콘솔 프로세스를 직접 생성                           | WMI가 GUI launcher 생성        |
| 미등록 fallback        | Node `spawn(powershell.exe)` | `windowsHide: true`, `stdio: ignore`, detached 없음으로 `CREATE_NO_WINDOW` | 기존 경로 유지                 |
