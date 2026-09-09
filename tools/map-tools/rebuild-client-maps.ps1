param(
  [string]$Client = $env:FFXIV_CLIENT,
  [string]$Project = (Join-Path $PSScriptRoot '..\..'),
  [string]$Output = (Join-Path $PSScriptRoot 'exports'),
  [ValidateSet('gridania','limsa')][string[]]$Maps = @('gridania','limsa'),
  [switch]$SkipExtract,
  [switch]$NoPublish,
  [string]$Node
)
$ErrorActionPreference = 'Stop'
# The Python entry point validates both scenes before atomically updating active.json.
# Previous releases and failed staging directories are retained; no recursive deletion.
$arguments = @((Join-Path $PSScriptRoot 'batch_rebuild.py'), '--project', $Project, '--output', $Output, '--scenes') + $Maps
if ($Client) { $arguments += @('--client', $Client) }
if ($SkipExtract) { $arguments += '--skip-extract' }
if ($NoPublish) { $arguments += '--no-publish' }
if ($Node) { $arguments += @('--node', $Node) }
& py -3 @arguments
exit $LASTEXITCODE
