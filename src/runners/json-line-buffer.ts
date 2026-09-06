// 개행 없는 비정상 출력도 메모리를 무한히 차지하지 않도록 모든 소비자가 같은 행 경계를 사용한다.
export const createJsonLineBuffer = (onLine: (line: string) => void, onDropped?: () => void) => {
  let buffer = '';
  let dropping = false;
  return {
    push(chunk: string) {
      for (const segment of chunk.split(/(?<=\n)/u)) {
        if (!dropping) {
          if (buffer.length + segment.length > 1024 * 1024) {
            buffer = '';
            dropping = true;
            onDropped?.();
          } else buffer += segment;
        }
        if (segment.endsWith('\n')) {
          if (!dropping) onLine(buffer);
          buffer = '';
          dropping = false;
        }
      }
    },
    flush() {
      if (buffer && !dropping) onLine(buffer);
      buffer = '';
    },
  };
};
