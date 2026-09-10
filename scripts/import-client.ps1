param(
  [string]$Client = $env:FFXIV_CLIENT,
  [string]$Tools = '',
  [string]$Output = '',
  [string[]]$Maps = @(),
  [string]$Node = '',
  [switch]$SkipExtract,
  [switch]$NoPublish
)
$ErrorActionPreference = 'Stop'
if (!$Client) { throw 'Specify -Client or set FFXIV_CLIENT to the installed client directory.' }
$project = Split-Path -Parent $PSScriptRoot
if (!$Tools) { $Tools = Join-Path $project 'tools\map-tools' }
if (!$Output) { $Output = Join-Path $Tools 'exports' }
$entry = Join-Path $Tools 'rebuild-client-maps.ps1'
if (!(Test-Path -LiteralPath $entry)) { throw "Map tools entry point not found: $entry" }
$parameters = @{
  Client = $Client
  Project = $project
  Output = $Output
  SkipExtract = $SkipExtract
  NoPublish = $NoPublish
}
if ($Maps.Count) { $parameters.Maps = $Maps }
if ($Node) { $parameters.Node = $Node }
& $entry @parameters
if ($LASTEXITCODE -ne 0) { throw "Map rebuild failed (exit $LASTEXITCODE). See the tool logs." }
