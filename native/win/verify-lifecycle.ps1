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
$api = $null

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
    "$ApiPort"
  ) -PassThru -WindowStyle Hidden
  $env:PATH = "$(Join-Path $prefix 'bin');$prefix;$env:PATH"
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

  $wrapper = Join-Path $env:USERPROFILE '.agentteams\agentrunner-start.ps1'
  $acl = (Invoke-NativeCommand -Description 'wrapper ACL query' -Command {
    & icacls.exe $wrapper
  }).Output
  if ($acl -match 'BUILTIN\\Users' -or $acl -match 'Everyone' -or $acl -match 'Authenticated Users') {
    throw "wrapper ACL still grants broad access:`n$acl"
  }

  foreach ($lifecycleCommand in @('restart', 'status', 'stop', 'uninstall')) {
    Invoke-NativeCommand -Description "agentrunner $lifecycleCommand" -Command {
      & agentrunner.cmd $lifecycleCommand
    } | Out-Null
  }
  Write-Host 'Windows package and scheduled-task lifecycle verification passed.'
} finally {
  if ($api) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
  Invoke-NativeCommand -Description 'scheduled task cleanup' -AllowedExitCodes @(0, 1) -Command {
    & schtasks.exe /Delete /TN 'AgentRunner' /F
  } | Out-Null
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
