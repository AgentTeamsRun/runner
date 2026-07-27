#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>

int wmain(void) {
  int argc;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  FILE *output;
  int index;
  int exit_code;
  if (argv == NULL || argc < 3) {
    return 64;
  }
  if (_wfopen_s(&output, argv[1], L"w, ccs=UTF-8") != 0 || output == NULL) {
    LocalFree(argv);
    return 73;
  }
  fwprintf(output, L"console=%d\n", GetConsoleWindow() == NULL ? 0 : 1);
  for (index = 3; index < argc; index++) {
    fwprintf(output, L"arg%d=%ls\n", index - 3, argv[index]);
  }
  fclose(output);
  exit_code = _wtoi(argv[2]);
  LocalFree(argv);
  return exit_code;
}

