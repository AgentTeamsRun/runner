param(
  [Parameter(Mandatory = $true)][string]$LauncherPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$PackageRoot = (Join-Path $PSScriptRoot '..\..')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-command.ps1')
. (Join-Path $PSScriptRoot 'hosted-runner-guard.ps1')
$global:LASTEXITCODE = 0

Invoke-NativeCommand -Description 'package negative fixtures' -Command {
  & node.exe --test (Join-Path $PSScriptRoot 'verify-package.test.mjs')
} | Out-Null
Invoke-NativeCommand -Description 'source and unpacked package fixture' -Command {
  & node.exe (Join-Path $PSScriptRoot 'verify-packed-package.mjs') $PackageRoot $ExpectedVersion
} | Out-Null

$multiline = Invoke-NativeCommand -Description 'multiline fixture' -Command {
  & cmd.exe /d /c "echo first&&echo 한글 출력"
}
if ($multiline.Output -ne "first$([Environment]::NewLine)한글 출력") {
  throw "native output normalization failed: $($multiline.Output)"
}

$allowedFailure = Invoke-NativeCommand -Description 'allowed cleanup fixture' -AllowedExitCodes @(0, 7) -Command {
  & cmd.exe /d /c "echo 지역화 오류 메시지 1>&2&&exit /b 7"
}
if ($allowedFailure.ExitCode -ne 7 -or [string]::IsNullOrWhiteSpace($allowedFailure.Output)) {
  throw 'allowed native exit-code fixture was not preserved'
}

$rejected = $false
try {
  Invoke-NativeCommand -Description 'rejected failure fixture' -Command {
    & cmd.exe /d /c "exit /b 9"
  } | Out-Null
} catch {
  $rejected = $_.Exception.Message -match 'exit 9'
}
if (-not $rejected) { throw 'unexpected native non-zero exit was not rejected' }
if ($LASTEXITCODE -ne 0) { throw 'native command exit code leaked into the caller scope' }

$missingExecutableRejected = $false
try {
  Invoke-NativeCommand -Description 'missing executable fixture' -Command {
    & 'definitely-missing-agentrunner-fixture.exe'
  } | Out-Null
} catch {
  $missingExecutableRejected = $_.Exception.Message -match `
    'missing executable fixture failed (to start|with exit)'
}
if (-not $missingExecutableRejected) { throw 'missing executable fixture was not rejected' }
if ($LASTEXITCODE -ne 0) { throw 'missing executable fixture leaked its exit status' }

$lifecycleGuardRejected = $false
try {
  Assert-GitHubHostedRunner -GithubActions 'true' -RunnerEnvironment 'self-hosted'
} catch {
  $lifecycleGuardRejected = $_.Exception.Message -match 'GitHub-hosted'
}
if (-not $lifecycleGuardRejected) { throw 'self-hosted lifecycle guard fixture was not rejected' }

Assert-WindowsLauncherVersion -BinaryPath $LauncherPath -ExpectedVersion $ExpectedVersion
$versionMismatchRejected = $false
try {
  Assert-WindowsLauncherVersion -BinaryPath $LauncherPath -ExpectedVersion '0.0.0-negative-fixture'
} catch {
  $versionMismatchRejected = $_.Exception.Message -match 'VERSIONINFO mismatch'
}
if (-not $versionMismatchRejected) { throw 'VERSIONINFO mismatch fixture was not rejected' }

Write-Host "PowerShell contract fixtures passed on $($PSVersionTable.PSVersion)."
