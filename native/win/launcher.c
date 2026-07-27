#define UNICODE
#define _UNICODE
#include <windows.h>
#include <string.h>
#include <wchar.h>

#define EXEC_DELIMITER L"--exec"
#define EXEC_DELIMITER_LENGTH 6
#define MODULE_PATH_CAPACITY 32768

static void report_failure(const wchar_t *message, DWORD error_code) {
  HANDLE source = RegisterEventSourceW(NULL, L"AgentTeams Runner");
  if (source != NULL) {
    wchar_t detail[512];
    const wchar_t *messages[1];
    _snwprintf_s(detail, 512, _TRUNCATE, L"%ls (Windows error %lu)", message, error_code);
    messages[0] = detail;
    ReportEventW(source, EVENTLOG_ERROR_TYPE, 0, 1, NULL, 1, 0, messages, NULL);
    DeregisterEventSource(source);
  }
}

static BOOL is_command_space(wchar_t value) {
  return value == L' ' || value == L'\t';
}

static const wchar_t *skip_command_spaces(const wchar_t *cursor) {
  while (is_command_space(*cursor)) {
    cursor++;
  }
  return cursor;
}

/* Skip this executable's own argv[0]. Task Scheduler builds the command line as
   `<Command> <Arguments>` without quoting <Command>, so a profile path with a
   space (C:\Users\John Doe\...) cannot be skipped by scanning to the first
   whitespace. Match the real module path instead and only fall back to the
   whitespace heuristic when that fails. */
static const wchar_t *skip_program_name(const wchar_t *cursor) {
  static wchar_t module_path[MODULE_PATH_CAPACITY];
  DWORD length;

  if (*cursor == L'"') {
    cursor++;
    while (*cursor != L'\0' && *cursor != L'"') {
      cursor++;
    }
    if (*cursor == L'"') {
      cursor++;
    }
    return cursor;
  }

  length = GetModuleFileNameW(NULL, module_path, (DWORD)MODULE_PATH_CAPACITY);
  if (length > 0 && length < (DWORD)MODULE_PATH_CAPACITY && _wcsnicmp(cursor, module_path, length) == 0) {
    return cursor + length;
  }

  while (*cursor != L'\0' && !is_command_space(*cursor)) {
    cursor++;
  }
  return cursor;
}

/* The scheduled task and the WMI restart helper both separate argv[0] from the
   child command line with an explicit `--exec` token, so the child command is
   recoverable even when argv[0] could not be measured exactly. */
static const wchar_t *find_exec_tail(const wchar_t *start, const wchar_t *command_line) {
  const wchar_t *cursor = start;
  while (*cursor != L'\0') {
    if ((cursor == command_line || is_command_space(cursor[-1])) &&
        wcsncmp(cursor, EXEC_DELIMITER, EXEC_DELIMITER_LENGTH) == 0 &&
        is_command_space(cursor[EXEC_DELIMITER_LENGTH])) {
      return skip_command_spaces(cursor + EXEC_DELIMITER_LENGTH);
    }
    cursor++;
  }
  return NULL;
}

static const wchar_t *find_child_command(const wchar_t *command_line) {
  const wchar_t *after_program = skip_program_name(skip_command_spaces(command_line));
  const wchar_t *exec_tail = find_exec_tail(after_program, command_line);
  if (exec_tail != NULL) {
    return exec_tail;
  }
  return skip_command_spaces(after_program);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous_instance, PWSTR command_line, int show_command) {
  const wchar_t *child_command;
  wchar_t *mutable_command;
  STARTUPINFOW startup_info;
  PROCESS_INFORMATION process_info;
  DWORD child_exit_code = 1;
  size_t length;
  BOOL created;

  (void)instance;
  (void)previous_instance;
  (void)command_line;
  (void)show_command;

  child_command = find_child_command(GetCommandLineW());
  if (*child_command == L'\0') {
    report_failure(L"No child command was provided to the Windows launcher", ERROR_INVALID_PARAMETER);
    return 64;
  }

  length = wcslen(child_command);
  mutable_command = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(wchar_t));
  if (mutable_command == NULL) {
    report_failure(L"Failed to allocate the child command line", ERROR_OUTOFMEMORY);
    return 70;
  }
  memcpy(mutable_command, child_command, (length + 1) * sizeof(wchar_t));

  ZeroMemory(&startup_info, sizeof(startup_info));
  startup_info.cb = sizeof(startup_info);
  ZeroMemory(&process_info, sizeof(process_info));
  created = CreateProcessW(
      NULL,
      mutable_command,
      NULL,
      NULL,
      FALSE,
      CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
      NULL,
      NULL,
      &startup_info,
      &process_info);
  HeapFree(GetProcessHeap(), 0, mutable_command);

  if (!created) {
    DWORD error_code = GetLastError();
    report_failure(L"Failed to create the launcher child process", error_code);
    return (int)(error_code == 0 ? 1 : error_code);
  }

  if (WaitForSingleObject(process_info.hProcess, INFINITE) != WAIT_OBJECT_0) {
    DWORD error_code = GetLastError();
    report_failure(L"Failed while waiting for the launcher child process", error_code);
    CloseHandle(process_info.hThread);
    CloseHandle(process_info.hProcess);
    return 71;
  }
  if (!GetExitCodeProcess(process_info.hProcess, &child_exit_code)) {
    DWORD error_code = GetLastError();
    report_failure(L"Failed to read the launcher child exit code", error_code);
    child_exit_code = 72;
  }

  CloseHandle(process_info.hThread);
  CloseHandle(process_info.hProcess);
  return (int)child_exit_code;
}

