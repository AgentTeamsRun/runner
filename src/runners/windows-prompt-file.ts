import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
