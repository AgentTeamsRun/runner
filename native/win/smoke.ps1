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
$resultPath = Join-Path $buildDir "agentrunner-native-smoke-$PID.txt"
$spacedResultPath = Join-Path $buildDir "agentrunner-native-smoke-spaced-$PID.txt"
$spacedLauncher = Join-Path $spacedDir 'agentrunner-launcher.exe'

try {
  Invoke-NativeCommand -Description 'smoke child build' -Command {
    & cl.exe /nologo /W4 /WX /O2 /MT "/Fo$smokeObject" (Join-Path $PSScriptRoot 'smoke-child.c') `
      /link /SUBSYSTEM:CONSOLE /MACHINE:X64 "/OUT:$fixture" shell32.lib
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

  $headers = (Invoke-NativeCommand -Description 'dumpbin.exe' -Command {
    & dumpbin.exe /headers $launcher
  }).Output
  if ($headers -notmatch '(?m)^\s*8664 machine' -or $headers -notmatch '(?m)^\s*2 subsystem') {
    throw "launcher is not an x64 Windows GUI executable:`n$headers"
  }
} finally {
  Remove-Item -LiteralPath $resultPath, $spacedResultPath, $fixture, $smokeObject, $spacedLauncher `
    -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $spacedDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Windows native launcher smoke passed.'
