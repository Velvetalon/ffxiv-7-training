param(
  [string]$Client = $env:FFXIV_CLIENT,
  [string]$Project = (Join-Path $PSScriptRoot '..\..'),
  [string]$Output = (Join-Path $PSScriptRoot 'exports'),
  [string[]]$Maps = @(),
  [switch]$SkipExtract,
  [switch]$NoPublish,
  [switch]$EstimateOnly,
  [string]$Node
)
$ErrorActionPreference = 'Stop'
# The Python entry point validates both scenes before atomically updating active.json.
# Previous releases and failed staging directories are retained; no recursive deletion.
$arguments = @((Join-Path $PSScriptRoot 'batch_rebuild.py'), '--project', $Project, '--output', $Output)
if ($Maps.Count) { $arguments += '--scenes'; $arguments += $Maps }
if ($Client) { $arguments += @('--client', $Client) }
if ($SkipExtract) { $arguments += '--skip-extract' }
if ($NoPublish) { $arguments += '--no-publish' }
if ($EstimateOnly) { $arguments += '--estimate-only' }
if ($Node) { $arguments += @('--node', $Node) }
& py -3 @arguments
exit $LASTEXITCODE
