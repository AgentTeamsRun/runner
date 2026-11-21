import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { logger } from '../logger.js';

// Windows에서는 prompt를 PowerShell 스크립트에 넣지 않고 파일로 전달한다. here-string(`@'`…`'@`)은
// 줄 맨 앞의 `'@`에서 닫히므로 prompt에 그 줄이 있으면 뒷부분이 Runner 계정의 PowerShell 코드가 된다.
// 파일 경유는 -EncodedCommand의 command-line 길이 제한도 함께 피한다.

const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const toWindowsPromptFilePath = (cwd: string, triggerId: string): string =>
  join(cwd, '.agentteams', 'runner', 'tmp', `${triggerId}.prompt.txt`);

/** `$utf8NoBom`이 앞에서 정의된 스크립트에서 prompt 파일을 `$promptText`로 읽는 한 줄. */
export const toPowerShellPromptFileRead = (promptFilePath: string): string =>
  `$promptText = [System.IO.File]::ReadAllText(${toPowerShellLiteral(promptFilePath)}, $utf8NoBom)`;

// Windows PowerShell 5.1은 네이티브 실행 파일 인자의 내장 `"`를 이스케이프하지 않고, 공백이 따옴표 쌍 안에 있다고
// 보면 인자를 감싸지도 않는다. prompt를 인자로 넘기면 `"`가 든 줄에서 인자가 쪼개지고 뒤 플래그가 prompt에 섞인다.
// 그래서 인자를 CommandLineToArgvW 규칙으로 직접 인용해 Process.Start로 실행한다. 자식은 PowerShell의 표준 핸들을
// 그대로 물려받는다. `.cmd`/`.bat`은 cmd.exe가 명령줄을 다시 해석해(줄바꿈에서 잘리고 `%`가 확장된다) 이 방식으로도
// 원문을 보장할 수 없으므로 기존 `&` 호출을 유지한다.
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
  '  exit $process.ExitCode',
  '}',
];

/** 실행 파일을 `argSegment`(앞에 공백이 붙은 PowerShell 인자 식)로 실행하는 스크립트 줄. prompt를 인자로 넘기는 러너용. */
export const toPowerShellNativeInvocation = (executablePath: string, argSegment: string): string => {
  const extension = extname(executablePath).toLowerCase();
  if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
    return `& ${toPowerShellLiteral(executablePath)}${argSegment}`;
  }
  return [
    ...POWERSHELL_NATIVE_INVOKE_FUNCTION,
    `Invoke-NativeCommand ${toPowerShellLiteral(executablePath)}${argSegment}`,
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
