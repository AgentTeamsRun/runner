param([string]$Version)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-command.ps1')
if (-not $Version) {
  $packageJsonPath = Join-Path $PSScriptRoot '..\..\package.json'
  $Version = (Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json).version
}
& (Join-Path $PSScriptRoot 'build.ps1') -Version $Version
$outputDir = Join-Path $PSScriptRoot '..\bin\win32-x64'
$launcher = Join-Path $outputDir 'agentrunner-launcher.exe'

# Smoke fixtures must never be built into the packaged artifact directory:
# a failed assertion would leave test binaries inside `files` of the npm tarball.
$buildRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$buildDir = Join-Path $buildRoot 'agentrunner-native-build'
# A directory whose name contains a space reproduces the `C:\Users\John Doe`
# profile layout that broke the launcher's command-line tail parsing.
$spacedDir = Join-Path $buildDir 'agent runner smoke'
New-Item -ItemType Directory -Path $buildDir, $spacedDir -Force | Out-Null

$fixture = Join-Path $buildDir 'smoke-child.exe'
$smokeObject = Join-Path $buildDir 'smoke-child.obj'
$failureLauncher = Join-Path $buildDir 'agentrunner-launcher-assign-failure.exe'
$failureObject = Join-Path $buildDir 'launcher-assign-failure.obj'
$resumeFailureLauncher = Join-Path $buildDir 'agentrunner-launcher-resume-failure.exe'
$resumeFailureObject = Join-Path $buildDir 'launcher-resume-failure.obj'
function Wait-GrandchildPid {
  param([string]$MarkerPath, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $MarkerPath) {
      $markerText = Get-Content -LiteralPath $MarkerPath -Raw -ErrorAction SilentlyContinue
      $markerPid = 0
      if ($markerText -and [int]::TryParse($markerText.Trim(), [ref]$markerPid) -and $markerPid -gt 0) {
        return $markerPid
      }
    }
    Start-Sleep -Milliseconds 200
  }
  throw "grandchild marker never contained a valid PID: $MarkerPath"
}

function Wait-ProcessGone {
  param([int]$ProcessId, [int]$TimeoutSeconds = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  return ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

$resultPath = Join-Path $buildDir "agentrunner-native-smoke-$PID.txt"
$spacedResultPath = Join-Path $buildDir "agentrunner-native-smoke-spaced-$PID.txt"
$spacedLauncher = Join-Path $spacedDir 'agentrunner-launcher.exe'

try {
  Invoke-NativeCommand -Description 'smoke child build' -Command {
    & cl.exe /nologo /W4 /WX /O2 /MT "/Fo$smokeObject" (Join-Path $PSScriptRoot 'smoke-child.c') `
      /link /SUBSYSTEM:CONSOLE /MACHINE:X64 "/OUT:$fixture" shell32.lib
  } | Out-Null

  # Build a test-only launcher that deterministically enters the fail-loud branch.
  Invoke-NativeCommand -Description 'job assignment failure launcher build' -Command {
    & cl.exe /nologo /W4 /WX /O2 /MT /DAGENTRUNNER_TEST_FORCE_JOB_ASSIGN_FAILURE `
      "/Fo$failureObject" (Join-Path $PSScriptRoot 'launcher.c') `
      /link /SUBSYSTEM:WINDOWS /MACHINE:X64 "/OUT:$failureLauncher" advapi32.lib
  } | Out-Null
  Invoke-NativeCommand -Description 'child resume failure launcher build' -Command {
    & cl.exe /nologo /W4 /WX /O2 /MT /DAGENTRUNNER_TEST_FORCE_CHILD_RESUME_FAILURE `
      "/Fo$resumeFailureObject" (Join-Path $PSScriptRoot 'launcher.c') `
      /link /SUBSYSTEM:WINDOWS /MACHINE:X64 "/OUT:$resumeFailureLauncher" advapi32.lib
  } | Out-Null

  $unicodeValue = -join ([char[]](0xD55C, 0xAE00, 0x20, 0xAC12))
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $launcher
  $startInfo.Arguments = "--exec `"$fixture`" `"$resultPath`" 42 `"$unicodeValue`" `"quoted value`""
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  $process.WaitForExit()
  if ($process.ExitCode -ne 42) { throw "launcher returned $($process.ExitCode) instead of 42" }
  $result = Get-Content -LiteralPath $resultPath -Raw
  if ($result -notmatch 'console=0' -or
      $result -notmatch "arg0=$([regex]::Escape($unicodeValue))" -or
      $result -notmatch 'arg1=quoted value') {
    throw "native smoke output did not match the launcher contract: $result"
  }

  # Task Scheduler puts `<Command>` on the command line unquoted. Reproduce that
  # exact shape through WMI — the same mechanism the web restart helper uses —
  # from a launcher path that contains a space.
  Copy-Item -LiteralPath $launcher -Destination $spacedLauncher -Force
  $spacedCommandLine = "$spacedLauncher --exec `"$fixture`" `"$spacedResultPath`" 7 `"spaced path`""
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $spacedCommandLine
  }
  if ($created.ReturnValue -ne 0) {
    throw "Win32_Process.Create failed with ReturnValue $($created.ReturnValue) for the spaced launcher path"
  }
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $spacedResultPath) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $spacedResultPath)) {
    throw "the launcher at a spaced, unquoted path never started its child: $spacedCommandLine"
  }
  $spacedResult = Get-Content -LiteralPath $spacedResultPath -Raw
  if ($spacedResult -notmatch 'console=0' -or $spacedResult -notmatch 'arg0=spaced path') {
    throw "spaced-path smoke output did not match the launcher contract: $spacedResult"
  }

  $missingStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $missingStartInfo.FileName = $launcher
  $missingStartInfo.Arguments = '--exec Z:\definitely-missing-agentrunner-child.exe'
  $missingStartInfo.UseShellExecute = $false
  $missingStartInfo.CreateNoWindow = $true
  $missingProcess = [Diagnostics.Process]::Start($missingStartInfo)
  $missingProcess.WaitForExit()
  if ($missingProcess.ExitCode -eq 0) { throw 'missing child unexpectedly returned success' }

  foreach ($failureCase in @(
      @{ Name = 'job assignment'; Launcher = $failureLauncher; ExitCode = 74 },
      @{ Name = 'child resume'; Launcher = $resumeFailureLauncher; ExitCode = 75 }
    )) {
    $failureMarker = Join-Path $buildDir "agentrunner-native-failure-$($failureCase.ExitCode)-$PID.txt"
    Remove-Item -LiteralPath $failureMarker -Force -ErrorAction SilentlyContinue
    try {
      $failureStartInfo = [Diagnostics.ProcessStartInfo]::new()
      $failureStartInfo.FileName = $failureCase.Launcher
      $failureStartInfo.Arguments = "--kill-tree-on-exit --exec `"$fixture`" `"$failureMarker`" 0"
      $failureStartInfo.UseShellExecute = $false
      $failureStartInfo.CreateNoWindow = $true
      $failureProcess = [Diagnostics.Process]::Start($failureStartInfo)
      if (-not $failureProcess.WaitForExit(30000)) {
        $failureProcess.Kill()
        throw "$($failureCase.Name) failure launcher did not exit"
      }
      if ($failureProcess.ExitCode -ne $failureCase.ExitCode) {
        throw "$($failureCase.Name) failure returned $($failureProcess.ExitCode) instead of $($failureCase.ExitCode)"
      }
      if (Test-Path -LiteralPath $failureMarker) {
        throw "$($failureCase.Name) failure allowed the suspended child to run"
      }
    } finally {
      Remove-Item -LiteralPath $failureMarker -Force -ErrorAction SilentlyContinue
    }
  }

  $killMarker = Join-Path $buildDir "agentrunner-native-grandchild-$PID.txt"
  $keepMarker = Join-Path $buildDir "agentrunner-native-nojob-grandchild-$PID.txt"
  $killGrandchildPid = $null
  $keepGrandchildPid = $null
  Remove-Item -LiteralPath $killMarker, $keepMarker -Force -ErrorAction SilentlyContinue
  try {
    # Mode on, normal exit: the child spawns a grandchild and exits, the
    # launcher exits with it, and closing the last job handle must take the
    # grandchild with it through KILL_ON_JOB_CLOSE.
    $killStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $killStartInfo.FileName = $launcher
    $killStartInfo.Arguments = "--kill-tree-on-exit --exec `"$fixture`" --spawn-grandchild `"$killMarker`" 60"
    $killStartInfo.UseShellExecute = $false
    $killStartInfo.CreateNoWindow = $true
    $killProcess = [Diagnostics.Process]::Start($killStartInfo)
    $killGrandchildPid = Wait-GrandchildPid -MarkerPath $killMarker
    $killProcess.WaitForExit()
    if ($killProcess.ExitCode -ne 0) { throw "kill-tree launcher returned $($killProcess.ExitCode) instead of 0" }
    if (-not (Wait-ProcessGone -ProcessId $killGrandchildPid -TimeoutSeconds 15)) {
      throw "kill-tree mode left grandchild $killGrandchildPid alive after the launcher exited"
    }
    $killGrandchildPid = $null

    # Mode on, launcher killed mid-run (what schtasks /End does to the direct
    # child): the running child must die with it.
    $sleeperMarker = Join-Path $buildDir "agentrunner-native-sleeper-$PID.txt"
    $sleeperPid = $null
    try {
      $sleeperStartInfo = [Diagnostics.ProcessStartInfo]::new()
      $sleeperStartInfo.FileName = $launcher
      $sleeperStartInfo.Arguments = "--kill-tree-on-exit --exec `"$fixture`" --sleeper `"$sleeperMarker`" 60"
      $sleeperStartInfo.UseShellExecute = $false
      $sleeperStartInfo.CreateNoWindow = $true
      $sleeperProcess = [Diagnostics.Process]::Start($sleeperStartInfo)
      $sleeperPid = Wait-GrandchildPid -MarkerPath $sleeperMarker
      $sleeperProcess.Kill()
      $sleeperProcess.WaitForExit()
      if (-not (Wait-ProcessGone -ProcessId $sleeperPid -TimeoutSeconds 15)) {
        throw "kill-tree mode left child $sleeperPid alive after the launcher was killed"
      }
      $sleeperPid = $null
    } finally {
      if ($sleeperPid) {
        Get-Process -Id $sleeperPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      }
      Remove-Item -LiteralPath $sleeperMarker -Force -ErrorAction SilentlyContinue
    }

    # Mode off: the launcher exits with its child while the grandchild keeps
    # running, preserving the pre-existing behavior byte for byte.
    $keepStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $keepStartInfo.FileName = $launcher
    $keepStartInfo.Arguments = "--exec `"$fixture`" --spawn-grandchild `"$keepMarker`" 60"
    $keepStartInfo.UseShellExecute = $false
    $keepStartInfo.CreateNoWindow = $true
    $keepProcess = [Diagnostics.Process]::Start($keepStartInfo)
    $keepProcess.WaitForExit()
    if ($keepProcess.ExitCode -ne 0) { throw "launcher without the flag returned $($keepProcess.ExitCode) instead of 0" }
    $keepGrandchildPid = Wait-GrandchildPid -MarkerPath $keepMarker
    if (-not (Get-Process -Id $keepGrandchildPid -ErrorAction SilentlyContinue)) {
      throw 'without kill-tree mode the grandchild died with its parent'
    }

    # Kill-tree mode with a missing child still fails loudly instead of
    # running anything.
    $flagMissingStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $flagMissingStartInfo.FileName = $launcher
    $flagMissingStartInfo.Arguments = '--kill-tree-on-exit --exec Z:\definitely-missing-agentrunner-child.exe'
    $flagMissingStartInfo.UseShellExecute = $false
    $flagMissingStartInfo.CreateNoWindow = $true
    $flagMissingProcess = [Diagnostics.Process]::Start($flagMissingStartInfo)
    $flagMissingProcess.WaitForExit()
    if ($flagMissingProcess.ExitCode -eq 0) { throw 'missing child with kill-tree mode unexpectedly returned success' }
  } finally {
    if ($killGrandchildPid) {
      Get-Process -Id $killGrandchildPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if ($keepGrandchildPid) {
      Get-Process -Id $keepGrandchildPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $killMarker, $keepMarker -Force -ErrorAction SilentlyContinue
  }

  $headers = (Invoke-NativeCommand -Description 'dumpbin.exe' -Command {
    & dumpbin.exe /headers $launcher
  }).Output
  if ($headers -notmatch '(?m)^\s*8664 machine' -or $headers -notmatch '(?m)^\s*2 subsystem') {
    throw "launcher is not an x64 Windows GUI executable:`n$headers"
  }
} finally {
  Remove-Item -LiteralPath $resultPath, $spacedResultPath, $fixture, $smokeObject, $spacedLauncher, `
    $failureLauncher, $failureObject, $resumeFailureLauncher, $resumeFailureObject `
    -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $spacedDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Windows native launcher smoke passed.'
