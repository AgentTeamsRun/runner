import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { logger } from '../logger.js';
import { resolveWindowsCmdShimTarget, type WindowsLaunchTarget } from '../windows-cmd-shim.js';
import { toPowerShellLiteral, toPowerShellNativeArgLiteral } from '../windows-powershell.js';

export { toPowerShellNativeArgLiteral };

// Windows에서는 prompt를 PowerShell 스크립트에 넣지 않고 파일로 전달한다. here-string(`@'`…`'@`)은
// 줄 맨 앞의 `'@`에서 닫히므로 prompt에 그 줄이 있으면 뒷부분이 Runner 계정의 PowerShell 코드가 된다.
// 파일 경유는 -EncodedCommand의 command-line 길이 제한도 함께 피한다.

/**
 * 모든 러너의 Windows PowerShell 스크립트가 공유하는 머리말.
 *
 * `$ProgressPreference`: stderr가 파이프인 powershell.exe는 모듈 자동 로드 진행 레코드를
 * (`Preparing modules for first use.`) CLIXML로 stderr에 쓴다. 러너는 stderr의 마지막 청크를 실패 사유
 * 후보로 쓰므로, 끄지 않으면 진짜 오류 대신 `#< CLIXML <Objs …>`가 사유로 올라간다.
 *
 * `trap`: PowerShell 자체의 종료 오류(실행 파일 없음, `Process.Start` 실패, prompt 파일 읽기 실패)도 stderr가
 * 파이프면 CLIXML로 나간다. 메시지만 평문으로 쓰고 1로 끝내 실패 사유를 읽을 수 있게 한다. 엔진이 쓰는 stderr는
 * 핸들을 그대로 물려받으므로 영향받지 않는다.
 */
export const POWERSHELL_RUNNER_PREAMBLE: readonly string[] = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  'trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = $utf8NoBom',
  '[Console]::OutputEncoding = $utf8NoBom',
  '$OutputEncoding = $utf8NoBom',
  'chcp 65001 > $null',
];

export const toWindowsPromptFilePath = (cwd: string, triggerId: string): string =>
  join(cwd, '.agentteams', 'runner', 'tmp', `${triggerId}.prompt.txt`);

/** `$utf8NoBom`이 앞에서 정의된 스크립트에서 prompt 파일을 `$promptText`로 읽는 한 줄. */
export const toPowerShellPromptFileRead = (promptFilePath: string): string =>
  `$promptText = [System.IO.File]::ReadAllText(${toPowerShellLiteral(promptFilePath)}, $utf8NoBom)`;

// Windows PowerShell 5.1은 네이티브 실행 파일 인자의 내장 `"`를 이스케이프하지 않고, 공백이 따옴표 쌍 안에 있다고
// 보면 인자를 감싸지도 않는다. prompt를 인자로 넘기면 `"`가 든 줄에서 인자가 쪼개지고 뒤 플래그가 prompt에 섞인다.
// 그래서 인자를 CommandLineToArgvW 규칙으로 직접 인용해 Process.Start로 실행한다. 자식은 PowerShell의 표준 핸들을
// 그대로 물려받는다. npm `.cmd` shim은 실제 대상(node + 스크립트, 또는 .exe)으로 풀어 같은 방식으로 실행한다.
// 풀 수 없는 `.cmd`/`.bat`은 cmd.exe가 명령줄을 다시 해석해(줄바꿈에서 잘리고 `%`가 확장된다) 원문을 보장할 수
// 없지만, 추측으로 다른 것을 실행하지 않고 기존 `&` 호출을 유지한다.
// `.ps1`은 PowerShell이 해석하는 스크립트이므로 `Process.Start` 대신 `&`로 실행한다.
const POWERSHELL_NATIVE_INVOKE_FUNCTION = [
  'function ConvertTo-NativeArgument([string]$value) {',
  "  if ($value.Length -gt 0 -and $value -notmatch '[\\s\"]') { return $value }",
  "  return '\"' + (($value -replace '(\\\\*)\"', '$1$1\\\"') -replace '(\\\\+)$', '$1$1') + '\"'",
  '}',
  'function Invoke-NativeCommand {',
  '  $startInfo = New-Object System.Diagnostics.ProcessStartInfo',
  '  $startInfo.FileName = $args[0]',
  "  $startInfo.Arguments = (@($args | Select-Object -Skip 1) | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' '",
  '  $startInfo.UseShellExecute = $false',
  '  $startInfo.WorkingDirectory = (Get-Location).ProviderPath',
  '  $process = [System.Diagnostics.Process]::Start($startInfo)',
  '  $process.WaitForExit()',
  '  $global:LASTEXITCODE = $process.ExitCode',
  '}',
];

type ResolveLaunchTarget = (executablePath: string) => WindowsLaunchTarget | null;

/**
 * `&` 뒤에 올 호출 대상(실행 파일 + 선행 인자)의 PowerShell 식. prompt를 stdin으로 넘기는 러너용.
 * npm `.cmd` shim이면 실제 대상으로 풀어 cmd.exe가 모델·effort 같은 인자를 다시 해석하지 않게 한다.
 */
export const toPowerShellCallTarget = (
  executablePath: string,
  resolveLaunchTarget: ResolveLaunchTarget = resolveWindowsCmdShimTarget,
): string => {
  const target = resolveLaunchTarget(executablePath);
  if (!target) {
    return toPowerShellLiteral(executablePath);
  }
  return [toPowerShellLiteral(target.executablePath), ...target.leadingArgs.map(toPowerShellNativeArgLiteral)].join(
    ' ',
  );
};

/** 실행 파일을 `argSegment`(앞에 공백이 붙은 PowerShell 인자 식)로 실행하는 스크립트 줄. prompt를 인자로 넘기는 러너용. */
export const toPowerShellNativeInvocation = (
  executablePath: string,
  argSegment: string,
  resolveLaunchTarget: ResolveLaunchTarget = resolveWindowsCmdShimTarget,
): string => {
  const target = resolveLaunchTarget(executablePath) ?? { executablePath, leadingArgs: [] };
  const extension = extname(target.executablePath).toLowerCase();
  // `-EncodedCommand`는 마지막 명령의 성패만 0/1로 돌려주므로 두 분기 모두 실제 종료 코드를 명시적으로 넘긴다.
  if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
    return [`& ${toPowerShellLiteral(target.executablePath)}${argSegment}`, 'exit $LASTEXITCODE'].join('\r\n');
  }
  // Invoke-NativeCommand가 인자를 직접 인용하므로 선행 인자는 사전 이스케이프 없는 평범한 리터럴이어야 한다.
  const leadingSegment = target.leadingArgs.map((arg) => ` ${toPowerShellLiteral(arg)}`).join('');
  return [
    ...POWERSHELL_NATIVE_INVOKE_FUNCTION,
    `Invoke-NativeCommand ${toPowerShellLiteral(target.executablePath)}${leadingSegment}${argSegment}`,
    'exit $LASTEXITCODE',
  ].join('\r\n');
};

export const writeWindowsPromptFile = async (cwd: string, triggerId: string, prompt: string): Promise<string> => {
  const promptFilePath = toWindowsPromptFilePath(cwd, triggerId);
  await mkdir(dirname(promptFilePath), { recursive: true });
  await writeFile(promptFilePath, prompt, { encoding: 'utf8' });
  return promptFilePath;
};

export const removeWindowsPromptFile = async (promptFilePath: string | null, triggerId: string): Promise<void> => {
  if (!promptFilePath) return;
  try {
    await rm(promptFilePath, { force: true });
  } catch (error) {
    logger.warn('Failed to remove Windows prompt temp file', {
      triggerId,
      promptFilePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
