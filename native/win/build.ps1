param(
  [string]$Version,
  [switch]$SkipManifest
)

$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
if (-not $Version) {
  $Version = (Get-Content -LiteralPath (Join-Path $sourceDir '..\..\package.json') -Raw | ConvertFrom-Json).version
}
$outputDir = Join-Path $sourceDir '..\bin\win32-x64'
$buildDir = $null
if ($env:RUNNER_TEMP) {
  $buildDir = Join-Path $env:RUNNER_TEMP 'agentrunner-native-build'
} else {
  $buildDir = Join-Path $env:TEMP 'agentrunner-native-build'
}
New-Item -ItemType Directory -Path $outputDir, $buildDir -Force | Out-Null

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'MSVC was not found. Run this script from an x64 Native Tools command prompt.'
  }
  $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $devShell = Join-Path $installation 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
  Import-Module $devShell
  Enter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
}

# VERSIONINFO fields are 16-bit, and the dev channel appends the workflow run
# number (`<base>-dev.<run_number>`), so clamp instead of letting rc.exe fail or
# silently truncate once the counter passes 65535.
$numbers = [regex]::Matches($Version, '\d+') | ForEach-Object { [Math]::Min([int64]$_.Value, [int64]65535) }
while ($numbers.Count -lt 4) { $numbers += 0 }
$versionHeader = @"
#define VERSION_COMMA $($numbers[0]),$($numbers[1]),$($numbers[2]),$($numbers[3])
#define VERSION_STRING "$Version"
"@
$versionHeader | Set-Content -LiteralPath (Join-Path $buildDir 'version.h') -Encoding ascii

& rc.exe /nologo /I $buildDir /fo (Join-Path $buildDir 'launcher.res') (Join-Path $sourceDir 'launcher.rc')
if ($LASTEXITCODE -ne 0) { throw "rc.exe failed with exit $LASTEXITCODE" }
$launcherObject = Join-Path $buildDir 'launcher.obj'
$launcherBinary = Join-Path $outputDir 'agentrunner-launcher.exe'
& cl.exe /nologo /W4 /WX /O2 /MT "/Fo$launcherObject" (Join-Path $sourceDir 'launcher.c') `
  (Join-Path $buildDir 'launcher.res') /link /SUBSYSTEM:WINDOWS /MACHINE:X64 `
  "/OUT:$launcherBinary" advapi32.lib
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit $LASTEXITCODE" }

if (-not $SkipManifest) {
  & (Join-Path $sourceDir 'write-manifest.ps1') -Version $Version
}
