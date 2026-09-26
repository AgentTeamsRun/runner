#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static int write_process_id(const wchar_t *path) {
  FILE *output;
  if (_wfopen_s(&output, path, L"w, ccs=UTF-8") != 0 || output == NULL) {
    return 73;
  }
  fwprintf(output, L"%lu\n", (unsigned long)GetCurrentProcessId());
  fclose(output);
  return 0;
}

static int run_sleeper(const wchar_t *pid_path, const wchar_t *seconds_text) {
  int write_result;
  long seconds;
  wchar_t *end;
  if (pid_path == NULL || seconds_text == NULL) {
    return 64;
  }
  write_result = write_process_id(pid_path);
  if (write_result != 0) {
    return write_result;
  }
  seconds = wcstol(seconds_text, &end, 10);
  if (end == seconds_text || seconds < 0) {
    return 64;
  }
  if (seconds > 120) {
    seconds = 120;
  }
  Sleep((DWORD)seconds * 1000UL);
  return 0;
}

/* Wait for the marker before returning: in kill-tree mode the launcher closes
   its job as soon as this process exits and may kill the grandchild first. */
static int spawn_grandchild(const wchar_t *pid_path, const wchar_t *seconds_text) {
  static wchar_t own_path[32768];
  static wchar_t grandchild_command[32768 * 2];
  DWORD own_length;
  STARTUPINFOW startup_info;
  PROCESS_INFORMATION process_info;
  int formatted;
  BOOL created;
  ULONGLONG deadline;
  BOOL marker_ready = FALSE;
  if (pid_path == NULL || seconds_text == NULL) {
    return 64;
  }
  own_length = GetModuleFileNameW(NULL, own_path, 32768);
  if (own_length == 0 || own_length >= (DWORD)32768) {
    return 70;
  }
  formatted = _snwprintf_s(
      grandchild_command,
      32768 * 2,
      _TRUNCATE,
      L"\"%ls\" --sleeper \"%ls\" %ls",
      own_path,
      pid_path,
      seconds_text);
  if (formatted < 0) {
    return 70;
  }
  ZeroMemory(&startup_info, sizeof(startup_info));
  startup_info.cb = sizeof(startup_info);
  ZeroMemory(&process_info, sizeof(process_info));
  created = CreateProcessW(
      NULL,
      grandchild_command,
      NULL,
      NULL,
      FALSE,
      CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
      NULL,
      NULL,
      &startup_info,
      &process_info);
  if (!created) {
    return 72;
  }
  deadline = GetTickCount64() + 30000;
  do {
    FILE *marker = NULL;
    unsigned long marker_pid = 0;
    if (_wfopen_s(&marker, pid_path, L"r, ccs=UTF-8") == 0 && marker != NULL) {
      marker_ready = fwscanf_s(marker, L"%lu", &marker_pid) == 1 &&
                     marker_pid == (unsigned long)process_info.dwProcessId;
      fclose(marker);
    }
    if (marker_ready) {
      break;
    }
    if (WaitForSingleObject(process_info.hProcess, 0) == WAIT_OBJECT_0) {
      break;
    }
    Sleep(25);
  } while (GetTickCount64() < deadline);
  if (!marker_ready) {
    TerminateProcess(process_info.hProcess, 73);
  }
  CloseHandle(process_info.hThread);
  CloseHandle(process_info.hProcess);
  return marker_ready ? 0 : 73;
}

int wmain(void) {
  int argc;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  FILE *output;
  int index;
  int exit_code;
  int fixture_result;
  if (argv == NULL || argc < 3) {
    return 64;
  }
  if (wcscmp(argv[1], L"--sleeper") == 0) {
    if (argc < 4) {
      LocalFree(argv);
      return 64;
    }
    fixture_result = run_sleeper(argv[2], argv[3]);
    LocalFree(argv);
    return fixture_result;
  }
  if (wcscmp(argv[1], L"--spawn-grandchild") == 0) {
    if (argc < 4) {
      LocalFree(argv);
      return 64;
    }
    fixture_result = spawn_grandchild(argv[2], argv[3]);
    LocalFree(argv);
    return fixture_result;
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
