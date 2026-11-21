import { existsSync, readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

/** `.cmd` shim이 결국 실행하는 대상. `leadingArgs`는 사용자 인자 앞에 붙는다(node 스크립트 경로). */
export type WindowsLaunchTarget = {
  executablePath: string;
  leadingArgs: string[];
};

export type WindowsCmdShimDeps = {
  readFile?: (path: string) => string;
  isFile?: (path: string) => boolean;
  /** shim이 `node`를 PATH에서 찾으라고 할 때 쓸 node 실행 파일. */
  nodeExecutablePath?: string;
};

const MAX_SHIM_BYTES = 16 * 1024;

const isExistingFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

const readShim = (path: string): string => {
  if (statSync(path).size > MAX_SHIM_BYTES) {
    throw new Error('not a shim');
  }
  return readFileSync(path, 'utf8');
};

// npm(cmd-shim)이 만드는 두 형태의 마지막 줄(2026-11-21 windows-verify 실측):
//   node 스크립트: `… & "%_prog%"  "%dp0%\node_modules\@scope\pkg\dist\index.js" %*`
//   네이티브 바이너리: `"%dp0%\node_modules\pnpm\pnpm.exe"   %*`
const NODE_SCRIPT_LINE = /"%_prog%"\s+"%dp0%\\([^"%]+)"\s+%\*\s*$/u;
const NATIVE_BINARY_LINE = /^"%dp0%\\([^"%]+\.(?:exe|com))"\s+%\*\s*$/iu;
const NODE_PROGRAM = /^\s*SET "_prog=node"\s*$/imu;

/**
 * npm이 만든 `.cmd` shim을 풀어 실제 실행 대상을 돌려준다. 풀 수 없으면 null.
 *
 * shim을 그대로 실행하면 cmd.exe가 명령줄을 다시 해석한다. 인자의 줄바꿈에서 명령줄이 잘리고,
 * `&`·`|` 뒤가 별도 명령으로 실행되며, `%VAR%`가 확장되고, 길이도 8,191자로 제한된다(2026-11-21 실측:
 * 여러 줄 prompt가 첫 줄만 전달되고 뒤따르는 플래그까지 사라졌다). 대상을 직접 실행하면 cmd.exe를 거치지 않는다.
 *
 * 추측으로 실행하지 않는다: 알려진 두 형태와 정확히 맞고 대상 파일이 실제로 있을 때만 푼다.
 */
export const resolveWindowsCmdShimTarget = (
  shimPath: string,
  deps: WindowsCmdShimDeps = {},
): WindowsLaunchTarget | null => {
  if (win32.extname(shimPath).toLowerCase() !== '.cmd') {
    return null;
  }

  const isFile = deps.isFile ?? isExistingFile;
  let content: string;
  try {
    content = (deps.readFile ?? readShim)(shimPath);
  } catch {
    return null;
  }

  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return null;
  }

  const shimDirectory = win32.dirname(shimPath);

  const nativeBinary = NATIVE_BINARY_LINE.exec(lastLine);
  if (nativeBinary?.[1]) {
    const executablePath = win32.join(shimDirectory, nativeBinary[1]);
    return isFile(executablePath) ? { executablePath, leadingArgs: [] } : null;
  }

  const nodeScript = NODE_SCRIPT_LINE.exec(lastLine);
  if (!nodeScript?.[1] || !NODE_PROGRAM.test(content)) {
    return null;
  }

  const scriptPath = win32.join(shimDirectory, nodeScript[1]);
  if (!isFile(scriptPath)) {
    return null;
  }

  // shim과 같은 순서: 옆에 node.exe가 있으면 그것을, 없으면 PATH의 node를 쓴다. 데몬 자신이 node로
  // 돌고 있으므로 PATH의 node 대신 지금 실행 중인 node를 쓴다(PATH 조회가 실패할 일이 없다).
  const bundledNode = win32.join(shimDirectory, 'node.exe');
  const executablePath = isFile(bundledNode) ? bundledNode : (deps.nodeExecutablePath ?? process.execPath);
  return { executablePath, leadingArgs: [scriptPath] };
};
