param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$BinaryPath = (Join-Path $PSScriptRoot '..\bin\win32-x64\agentrunner-launcher.exe')
)

$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$manifestPath = Join-Path (Split-Path -Parent $binary) 'manifest.json'
$stream = [IO.File]::OpenRead($binary)
try {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $algorithm.Dispose()
  }
} finally {
  $stream.Dispose()
}
$manifest = @"
{
  "schemaVersion": 1,
  "version": "$Version",
  "platform": "win32",
  "arch": "x64",
  "fileName": "$(Split-Path -Leaf $binary)",
  "sha256": "$hash"
}
"@
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
