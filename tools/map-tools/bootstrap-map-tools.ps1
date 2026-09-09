[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$meddleRepository = 'https://github.com/PassiveModding/Meddle.git'
$meddleCommit = '7ef61f44f82c6363465d46b46e963a054d431c16'
$MeddleDirectory = Join-Path $PSScriptRoot 'Meddle'

if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'git is required to fetch the pinned Meddle source.'
}
if (-not (Test-Path -LiteralPath $MeddleDirectory)) {
  & git clone --filter=blob:none $meddleRepository $MeddleDirectory
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath (Join-Path $MeddleDirectory '.git'))) {
  throw "$MeddleDirectory exists but is not a Meddle git checkout. Choose an empty directory or remove it manually."
}
& git -C $MeddleDirectory fetch --depth 1 origin $meddleCommit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git -C $MeddleDirectory checkout --detach $meddleCommit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$actual = (& git -C $MeddleDirectory rev-parse HEAD).Trim()
if ($actual -ne $meddleCommit) { throw "Pinned Meddle checkout mismatch: expected $meddleCommit, got $actual." }

& (Join-Path $PSScriptRoot 'build.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "Bootstrap complete: Meddle $actual; MapExtract built. This script never downloads or modifies game files."
