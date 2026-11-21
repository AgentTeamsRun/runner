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
$previousRunnerCmd = $null
$runnerCmdOverridden = $false

# A stop or restart is only proven correct while a run is active: the runner has
# to cancel it, report CANCELLED and leave no engine behind. The fake engine
# below stands in for a real CLI and records its own PID so its survival can be
# checked independently of anything the runner says.
$runWorkDir = Join-Path $workDir 'run'
$enginePrefix = Join-Path $workDir 'engine'
$enginePidFile = Join-Path $workDir 'engine.pid'
$shutdownReason = 'Runner stopped because AgentRunner shut down or restarted'

function Start-ActiveRun {
  param([string]$TriggerId)

  Remove-Item -LiteralPath $enginePidFile -Force -ErrorAction SilentlyContinue
  Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/__test/offer-trigger/$TriggerId" | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $enginePidFile) {
      $enginePid = [int](Get-Content -LiteralPath $enginePidFile -Raw).Trim()
      if (Get-Process -Id $enginePid -ErrorAction SilentlyContinue) { return $enginePid }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "the fake engine for $TriggerId did not start within 90s"
}

function Assert-RunCancelled {
  param([string]$Description, [string]$TriggerId, [int]$EnginePid)

  $deadline = (Get-Date).AddSeconds(30)
  $engineAlive = $true
  $reported = $false
  while ((Get-Date) -lt $deadline) {
    $engineAlive = $null -ne (Get-Process -Id $EnginePid -ErrorAction SilentlyContinue)
    $reported = @(
      Select-String -Path $requestLog -SimpleMatch "STATUS $TriggerId CANCELLED $shutdownReason" -ErrorAction SilentlyContinue
    ).Count -gt 0
    if (-not $engineAlive -and $reported) { return }
    Start-Sleep -Milliseconds 500
  }
  $statusLines = (@(Select-String -Path $requestLog -SimpleMatch "STATUS $TriggerId" -ErrorAction SilentlyContinue) |
      ForEach-Object { $_.Line }) -join '; '
  throw "$Description : engine pid $EnginePid alive=$engineAlive; CANCELLED reported=$reported; status journal: [$statusLines]"
}

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

  # The runner refuses to start a run outside a git repository or an AgentTeams project.
  New-Item -ItemType Directory -Path (Join-Path $runWorkDir '.agentteams') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $runWorkDir '.agentteams\config.json') -Value '{}' -Encoding ascii

  # Installed the way npm installs a CLI (a `.cmd` shim in front of a node script),
  # because that is the shape the runner has to launch and tear down in the field.
  $enginePackage = Join-Path $enginePrefix 'node_modules\fake-engine'
  New-Item -ItemType Directory -Path $enginePackage -Force | Out-Null
  $enginePidFileLiteral = $enginePidFile | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $enginePackage 'main.js') -Encoding utf8 -Value @"
if (process.argv[2] !== 'run') { console.log('fake-engine 1.0.0'); process.exit(0); }
require('node:fs').writeFileSync($enginePidFileLiteral, String(process.pid));
console.log(JSON.stringify({ type: 'text', text: 'working' }));
setInterval(() => {}, 1000);
"@
  $engineShim = Join-Path $enginePrefix 'fake-engine.cmd'
  Set-Content -LiteralPath $engineShim -Encoding ascii -Value @'
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\fake-engine\main.js" %*
'@

  $api = Start-Process node -ArgumentList @(
    (Join-Path $repositoryRoot 'daemon/native/win/fake-api.mjs'),
    "$ApiPort",
    $requestLog,
    $runWorkDir
  ) -PassThru -WindowStyle Hidden
  # Same reason as the poll interval below: the task's runner reads the user's
  # registry environment, so the engine override has to live there too.
  $previousRunnerCmd = [Environment]::GetEnvironmentVariable('RUNNER_CMD', 'User')
  $runnerCmdOverridden = $true
  [Environment]::SetEnvironmentVariable('RUNNER_CMD', $engineShim, 'User')
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

  # Restart through the registered task while a run is active. `schtasks /End`
  # alone kills the tree without giving the runner a chance to report, so the
  # run would stay "active" on the server forever.
  $restartEnginePid = Start-ActiveRun -TriggerId 'run-before-restart'
  Invoke-NativeCommand -Description 'agentrunner restart' -Command {
    & agentrunner.cmd restart
  } | Out-Null
  # A restart that leaves the previous instance in place must not report success:
  # Wait-DaemonInstance throws unless a *different* ready instance shows up.
  Wait-DaemonInstance `
    -Description 'restart replacement' -Path $pidFile -NotInstanceId $firstInstance.instanceId | Out-Null
  Assert-RunCancelled `
    -Description 'restart through the registered task' -TriggerId 'run-before-restart' -EnginePid $restartEnginePid
  if (Get-Process -Id ([int]$firstInstance.pid) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node') {
    throw "the pre-restart runner (pid $($firstInstance.pid)) is still alive after the restart"
  }

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

  # `schtasks /End` must leave no runner behind. Capture the live record, end
  # the task, then assert the recorded PID (when it still belongs to a node
  # runner) and every node descendant are gone. A surviving runner keeps
  # holding `agentrunner.log`, so the next replacement dies with exit 1.
  $preEndInstance = Wait-DaemonInstance -Description 'pre-End live instance' -Path $pidFile
  Invoke-NativeCommand -Description 'scheduled task end' -Command {
    & schtasks.exe /End /TN 'AgentRunner'
  } | Out-Null
  $endDeadline = (Get-Date).AddSeconds(30)
  $residualPid = [int]$preEndInstance.pid
  $residualProcess = $null
  $residualDescendants = @()
  while ((Get-Date) -lt $endDeadline) {
    $candidate = Get-Process -Id $residualPid -ErrorAction SilentlyContinue
    $residualProcess = if ($candidate -and $candidate.ProcessName -eq 'node') { $candidate } else { $null }
    $residualDescendants = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $ancestorId = $_.ParentProcessId
        $depth = 0
        while ($ancestorId -and $ancestorId -ne $residualPid -and $depth -lt 32) {
          $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $ancestorId" -ErrorAction SilentlyContinue
          if (-not $parent) { break }
          $ancestorId = $parent.ParentProcessId
          $depth++
        }
        $ancestorId -eq $residualPid
      })
    if (-not $residualProcess -and $residualDescendants.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($residualProcess -or $residualDescendants.Count -gt 0) {
    $descList = ($residualDescendants | ForEach-Object { "$($_.ProcessId) (parent $($_.ParentProcessId))" }) -join ', '
    throw "schtasks /End left a residual runner behind: recorded pid $residualPid alive=$($null -ne $residualProcess); descendant node processes: $descList"
  }

  # Bring the task back so the remaining lifecycle commands exercise a live runner.
  Invoke-NativeCommand -Description 'scheduled task re-run after /End check' -Command {
    & schtasks.exe /Run /TN 'AgentRunner'
  } | Out-Null
  $preStopInstance = Wait-DaemonInstance `
    -Description 'post-End replacement' -Path $pidFile -NotInstanceId $preEndInstance.instanceId

  # `agentrunner stop` on a task-owned runner, again with a run in flight.
  $stopEnginePid = Start-ActiveRun -TriggerId 'run-before-stop'
  foreach ($lifecycleCommand in @('status', 'stop')) {
    Invoke-NativeCommand -Description "agentrunner $lifecycleCommand" -Command {
      & agentrunner.cmd $lifecycleCommand
    } | Out-Null
  }
  Assert-RunCancelled -Description 'agentrunner stop' -TriggerId 'run-before-stop' -EnginePid $stopEnginePid
  if (Get-Process -Id ([int]$preStopInstance.pid) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node') {
    throw "agentrunner stop returned while the runner (pid $($preStopInstance.pid)) was still alive"
  }
  # A graceful stop exits 0, so the task's RestartOnFailure must not bring the
  # runner back. A killed runner exits 1 and would be restarted within a minute.
  Start-Sleep -Seconds 75
  if (Test-Path -LiteralPath $pidFile) {
    throw "a runner came back after agentrunner stop: $(Get-Content -LiteralPath $pidFile -Raw)"
  }

  Invoke-NativeCommand -Description 'agentrunner uninstall' -Command {
    & agentrunner.cmd uninstall
  } | Out-Null
  Write-Host "Windows package and scheduled-task lifecycle verification passed (task priority $taskPriority, $pollCount polls observed after the restart)."
} finally {
  if ($pollingIntervalOverridden) {
    [Environment]::SetEnvironmentVariable('POLLING_INTERVAL_MS', $previousPollingInterval, 'User')
  }
  if ($runnerCmdOverridden) {
    [Environment]::SetEnvironmentVariable('RUNNER_CMD', $previousRunnerCmd, 'User')
  }
  if ($api) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
  Invoke-NativeCommand -Description 'scheduled task cleanup' -AllowedExitCodes @(0, 1) -Command {
    & schtasks.exe /Delete /TN 'AgentRunner' /F
  } | Out-Null
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
