param(
  [int]$ApiPort = 32109,
  [string]$PackageRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$TempRoot = $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP })
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-command.ps1')
. (Join-Path $PSScriptRoot 'hosted-runner-guard.ps1')
Assert-GitHubHostedRunner

$packageRootPath = (Resolve-Path -LiteralPath $PackageRoot).Path
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $packageRootPath '..')).Path
$expectedVersion = (Get-Content -LiteralPath (Join-Path $packageRootPath 'package.json') -Raw | ConvertFrom-Json).version
$workDir = Join-Path $TempRoot "agentrunner-lifecycle-$PID"
$packDir = Join-Path $workDir 'pack'
$prefix = Join-Path $workDir 'global'
$pidFile = Join-Path $env:USERPROFILE '.agentteams\daemon.pid'
$requestLog = Join-Path $workDir 'api-requests.log'
$api = $null
$previousPollingInterval = $null
$pollingIntervalOverridden = $false

# The scheduled task inherits the user's registry environment, not this shell's,
# so the poll interval has to be set at user scope to reach the task's runner.
# Without it three scheduled polls would cost 90s of paid Windows runner time.
$pollingIntervalOverrideMs = 2000
$requiredPollCount = 3

# The runner is only "started" once it has written its instance record and
# stamped itself ready; a process that exists but never initializes is exactly
# the failure this harness exists to catch.
function Wait-DaemonInstance {
  param([string]$Description, [string]$Path, [int]$TimeoutSeconds = 60, [string]$NotInstanceId = $null)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) {
      $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
      if ($raw) {
        $record = $null
        try { $record = $raw.Trim() | ConvertFrom-Json } catch { $record = $null }
        if ($record -and $record.instanceId -and $record.readyAt -and $record.instanceId -ne $NotInstanceId) {
          return $record
        }
      }
    }
    Start-Sleep -Milliseconds 500
  }
  if ($NotInstanceId) {
    throw "$Description : no ready runner instance other than $NotInstanceId appeared within ${TimeoutSeconds}s — the restart left the pre-restart instance in place (pid file: $Path)"
  }
  throw "$Description : no ready runner instance appeared within ${TimeoutSeconds}s (pid file: $Path)"
}

New-Item -ItemType Directory -Path $packDir -Force | Out-Null
try {
  Push-Location $packageRootPath
  try {
    $packResult = Invoke-NativeCommand -Description 'npm pack' -Command {
      & npm.cmd pack --json --silent --pack-destination $packDir
    }
  } finally {
    Pop-Location
  }
  $pack = $packResult.Output | ConvertFrom-Json
  $tarball = Join-Path $packDir $pack[0].filename
  $entries = @($pack[0].files.path)
  if ($entries -notcontains 'native/bin/win32-x64/agentrunner-launcher.exe' -or
      $entries -notcontains 'native/bin/win32-x64/manifest.json') {
    throw 'npm tarball is missing the native launcher artifact'
  }

  Invoke-NativeCommand -Description 'source and unpacked package verification' -Command {
    & node.exe (Join-Path $PSScriptRoot 'verify-packed-package.mjs') $packageRootPath $expectedVersion
  } | Out-Null
  Assert-WindowsLauncherVersion `
    -BinaryPath (Join-Path $packageRootPath 'native\bin\win32-x64\agentrunner-launcher.exe') `
    -ExpectedVersion $expectedVersion

  Invoke-NativeCommand -Description 'tarball global installation' -Command {
    & npm.cmd install --global --prefix $prefix $tarball
  } | Out-Null

  $api = Start-Process node -ArgumentList @(
    (Join-Path $repositoryRoot 'daemon/native/win/fake-api.mjs'),
    "$ApiPort",
    $requestLog
  ) -PassThru -WindowStyle Hidden
  $env:PATH = "$(Join-Path $prefix 'bin');$prefix;$env:PATH"
  # User scope is a persistent registry value, so a developer running this
  # locally must get their own setting back — not silently lose it.
  $previousPollingInterval = [Environment]::GetEnvironmentVariable('POLLING_INTERVAL_MS', 'User')
  $pollingIntervalOverridden = $true
  [Environment]::SetEnvironmentVariable('POLLING_INTERVAL_MS', "$pollingIntervalOverrideMs", 'User')
  Invoke-NativeCommand -Description 'agentrunner init' -Command {
    & agentrunner.cmd init --token ci-token --api-url "http://127.0.0.1:$ApiPort"
  } | Out-Null

  $taskXml = (Invoke-NativeCommand -Description 'scheduled task XML query' -Command {
    & schtasks.exe /Query /TN 'AgentRunner' /XML
  }).Output
  if ($taskXml -notmatch 'agentrunner-launcher-[^<]+\.exe' -or $taskXml -match 'AGENTTEAMS_DAEMON_TOKEN') {
    throw 'scheduled task does not use the content-addressed launcher safely'
  }
  if ($taskXml -notmatch '--exec' -or $taskXml -notmatch 'WindowsPowerShell\\v1\.0\\powershell\.exe') {
    throw 'scheduled task does not invoke PowerShell through the absolute, delimited launcher contract'
  }
  # Task Scheduler applies priority 7 (below-normal) when <Priority> is omitted,
  # and a below-normal runner can be starved indefinitely before it finishes
  # loading — the task then stays "Running" with nothing behind it.
  $taskPriority = if ($taskXml -match '<Priority>\s*(\d+)\s*</Priority>') { [int]$Matches[1] } else { 7 }
  if ($taskPriority -gt 6) {
    throw "scheduled task runs at priority $taskPriority (below-normal); the runner can be starved before it initializes"
  }

  $wrapper = Join-Path $env:USERPROFILE '.agentteams\agentrunner-start.ps1'
  $acl = (Invoke-NativeCommand -Description 'wrapper ACL query' -Command {
    & icacls.exe $wrapper
  }).Output
  if ($acl -match 'BUILTIN\\Users' -or $acl -match 'Everyone' -or $acl -match 'Authenticated Users') {
    throw "wrapper ACL still grants broad access:`n$acl"
  }

  # `init` starts the task, so the first real instance must come up through the
  # registered autostart path — not through a direct spawn.
  $firstInstance = Wait-DaemonInstance -Description 'autostart from the registered task' -Path $pidFile

  # Polls from the first instance prove nothing about the replacement, so the
  # journal is measured from the restart forward, not from the harness start.
  $baselinePollCount = @(
    Select-String -Path $requestLog -Pattern '/api/daemon-triggers/poll-state' -ErrorAction SilentlyContinue
  ).Count

  Invoke-NativeCommand -Description 'agentrunner restart' -Command {
    & agentrunner.cmd restart
  } | Out-Null
  # A restart that leaves the previous instance in place must not report success:
  # Wait-DaemonInstance throws unless a *different* ready instance shows up.
  Wait-DaemonInstance `
    -Description 'restart replacement' -Path $pidFile -NotInstanceId $firstInstance.instanceId | Out-Null

  # Independent evidence that the server kept receiving scheduled polls *after*
  # the restart, read from the fake API's own journal rather than from the runner.
  $pollDeadline = (Get-Date).AddSeconds(60)
  $pollCount = 0
  while ((Get-Date) -lt $pollDeadline) {
    $totalPollCount = @(
      Select-String -Path $requestLog -Pattern '/api/daemon-triggers/poll-state' -ErrorAction SilentlyContinue
    ).Count
    $pollCount = $totalPollCount - $baselinePollCount
    if ($pollCount -ge $requiredPollCount) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($pollCount -lt $requiredPollCount) {
    throw "the fake API observed only $pollCount scheduled polls after the restart; expected at least $requiredPollCount"
  }

  foreach ($lifecycleCommand in @('status', 'stop', 'uninstall')) {
    Invoke-NativeCommand -Description "agentrunner $lifecycleCommand" -Command {
      & agentrunner.cmd $lifecycleCommand
    } | Out-Null
  }
  Write-Host "Windows package and scheduled-task lifecycle verification passed (task priority $taskPriority, $pollCount polls observed after the restart)."
} finally {
  if ($pollingIntervalOverridden) {
    [Environment]::SetEnvironmentVariable('POLLING_INTERVAL_MS', $previousPollingInterval, 'User')
  }
  if ($api) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
  Invoke-NativeCommand -Description 'scheduled task cleanup' -AllowedExitCodes @(0, 1) -Command {
    & schtasks.exe /Delete /TN 'AgentRunner' /F
  } | Out-Null
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
