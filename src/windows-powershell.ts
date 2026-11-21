// Windows PowerShell 5.1(`powershell.exe`)로 네이티브 명령을 띄울 때 공유하는 리터럴 규칙.
// 러너 스크립트(`runners/windows-prompt-file.ts`)와 보조 호출(`executable.ts`)이 같은 규칙을 써야 한다.

export const toPowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

// .NET `char.IsWhiteSpace`와 같은 집합. JS `\s`와 다르다(U+0085·U+001C~1F 포함, U+FEFF 제외).
const isDotNetWhitespace = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
};

/**
 * `&`로 실행하는 네이티브 명령의 인자 하나를 PowerShell 리터럴로 만든다.
 *
 * Windows PowerShell 5.1은 인자의 내장 `"`를 이스케이프하지 않고 명령줄에 그대로 붙인다. 그래서
 * `'{"fastMode":true}'`는 자식에게 `{fastMode:true}`로 도착한다(2026-11-21 실측). 여기서 미리
 * CommandLineToArgvW 규칙(`"` → `\"`, 그 앞의 `\`는 두 배)으로 이스케이프해 두면 원문이 그대로 전달된다.
 * 5.1이 `"…"`로 감싸는 인자는 끝의 `\`가 닫는 따옴표를 먹지 않도록 두 배로 늘린다.
 * 원문을 보장할 수 없는 형태(따옴표 쌍 안에만 공백이 있는 인자)는 예외를 던진다.
 * `.cmd`/`.bat`으로 가는 인자의 cmd.exe 메타문자(`&|<>^%`, 줄바꿈)는 여기서 막지 못한다.
 *
 * 데몬은 항상 `powershell.exe`(5.1)를 띄우므로 이 동작에 맞춘다. 인자를 직접 인용하는
 * `Invoke-NativeCommand` 경로(`toPowerShellNativeInvocation`)에는 쓰지 않는다 — 이중 이스케이프가 된다.
 */
export const toPowerShellNativeArgLiteral = (value: string): string => {
  // 5.1의 `&`는 빈 인자를 통째로 버린다. `""`를 그대로 붙이게 하면 빈 인자로 도착한다.
  if (value.length === 0) {
    return toPowerShellLiteral('""');
  }

  const quoteEscaped = value.replace(/(\\*)"/g, '$1$1\\"');

  // 5.1은 `"`(우리가 넣은 `\"` 포함) 개수가 짝수인 지점에 공백이 있을 때만 인자를 감싼다.
  let quoteCount = 0;
  let hasWhitespace = false;
  let wrappedByPowerShell = false;
  for (const char of quoteEscaped) {
    if (char === '"') {
      quoteCount += 1;
    } else if (isDotNetWhitespace(char)) {
      hasWhitespace = true;
      if (quoteCount % 2 === 0) {
        wrappedByPowerShell = true;
      }
    }
  }

  if (hasWhitespace && !wrappedByPowerShell) {
    // 예: `a="b c"`. 5.1이 감싸지 않아 공백에서 인자가 쪼개지고, 직접 감싸면 다시 한 번 감싼다.
    // 조용히 다른 인자로 실행하느니 기동을 실패시킨다. 현재 데몬이 넘기는 인자에는 이 형태가 없다.
    throw new Error(`Cannot pass argument to a Windows command verbatim: ${JSON.stringify(value)}`);
  }

  return toPowerShellLiteral(wrappedByPowerShell ? quoteEscaped.replace(/(\\+)$/, '$1$1') : quoteEscaped);
};
