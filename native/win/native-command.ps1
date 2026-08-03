function ConvertTo-NativeOutputString {
  param([object[]]$InputObject)

  if ($null -eq $InputObject) { return '' }
  return (($InputObject | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command,
    [int[]]$AllowedExitCodes = @(0),
    [string]$Description = 'native command'
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $hasNativePreference = Test-Path Variable:PSNativeCommandUseErrorActionPreference
  if ($hasNativePreference) { $previousNativePreference = $PSNativeCommandUseErrorActionPreference }
  $previousExitCode = $global:LASTEXITCODE
  try {
    # Windows PowerShell promotes native stderr to NativeCommandError when the
    # caller uses Stop. Capture it as command output and decide solely from the
    # explicit exit-code contract so PS5 and PS7 behave identically.
    $ErrorActionPreference = 'Continue'
    if ($hasNativePreference) { $PSNativeCommandUseErrorActionPreference = $false }
    # A process launch failure does not update LASTEXITCODE. Clear the previous
    # value so command-not-found and permission errors cannot inherit success.
    $global:LASTEXITCODE = $null
    $output = & $Command 2>&1
    $exitCode = $global:LASTEXITCODE
  } catch {
    # Command discovery and process-start failures can be terminating even when
    # native stderr is configured as non-terminating output. Normalize them to
    # the same explicit launch-failure contract on PowerShell 5 and 7.
    $output = @($_)
    $exitCode = $null
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($hasNativePreference) { $PSNativeCommandUseErrorActionPreference = $previousNativePreference }
    # A fixture or cleanup command must not change the exit status observed by
    # the caller (notably the GitHub Actions PowerShell wrapper).
    $global:LASTEXITCODE = $previousExitCode
  }
  $normalizedOutput = ConvertTo-NativeOutputString -InputObject $output
  if ($null -eq $exitCode) {
    throw "$Description failed to start`n$normalizedOutput"
  }
  if ($AllowedExitCodes -notcontains $exitCode) {
    throw "$Description failed with exit $exitCode`n$normalizedOutput"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $normalizedOutput
  }
}

function Assert-WindowsLauncherVersion {
  param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )

  $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path -LiteralPath $BinaryPath).Path)
  if ($versionInfo.FileVersion -ne $ExpectedVersion -or $versionInfo.ProductVersion -ne $ExpectedVersion) {
    throw "Windows launcher VERSIONINFO mismatch: expected=$ExpectedVersion, file=$($versionInfo.FileVersion), product=$($versionInfo.ProductVersion)"
  }
}
