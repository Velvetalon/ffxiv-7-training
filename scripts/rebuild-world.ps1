param(
  [string]$Client = $env:FFXIV_CLIENT,
  [string]$Tools = '',
  [string]$Node = '',
  [string]$ResumeRun = '',
  [switch]$NoPublish
)
$ErrorActionPreference = 'Stop'
if (!$Client) { throw 'Pass -Client or set FFXIV_CLIENT.' }
$project = Split-Path -Parent $PSScriptRoot
if (!$Tools) { $Tools = Join-Path $project 'tools\map-tools' }
if (!$Node) {
  $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  $Node = if (Test-Path -LiteralPath $runtimeNode) { $runtimeNode } else { (Get-Command node -ErrorAction Stop).Source }
}
$work = Join-Path $project 'work\world-build'
[void][System.IO.Directory]::CreateDirectory($work)
$batch = @((Join-Path $Tools 'batch_rebuild.py'), '--client', $Client, '--project', $project, '--node', $Node, '--no-publish')
if ($ResumeRun) { $batch += @('--resume-run', $ResumeRun) }
& py -3 @batch
if ($LASTEXITCODE -ne 0) { throw 'Conversion failed; see the native run report. Resume that run after fixing its failing step.' }
$progress = Get-Content -LiteralPath (Join-Path $Tools 'work\overworld-conversion-progress.json') -Raw | ConvertFrom-Json
if ($progress.state -ne 'validated') { throw 'The conversion run has not passed validation.' }
. (Join-Path $Tools 'toolchain.ps1')
$dotnet = Get-MapToolsDotnet -Root $Tools
$graph = Join-Path $work 'connections.json'
& py -3 (Join-Path $Tools 'world_connections.py') --catalog (Join-Path $Tools 'world-catalog.json') --exports (Join-Path $work 'plans') --fetch --client $Client --dotnet $dotnet --mapextract (Join-Path $Tools 'bin\MapExtract.dll') --output $graph
if ($LASTEXITCODE -ne 0) { throw 'Source connection extraction failed.' }
& $Node (Join-Path $PSScriptRoot 'finalize-world.mjs') "--root=$($progress.stage)" "--connections=$graph"
if ($LASTEXITCODE -ne 0) { throw 'World endpoint grounding failed; inspect world-finalization.json.' }
& $Node (Join-Path $PSScriptRoot 'verify-extracted.mjs') "--root=$($progress.stage)"
if ($LASTEXITCODE -ne 0) { throw 'Final map verification failed.' }
& $Node (Join-Path $PSScriptRoot 'verify-world.mjs') "--root=$($progress.stage)" "--connections=$graph"
if ($LASTEXITCODE -ne 0) { throw 'World connection verification failed.' }
$packaged = Join-Path $project "public\extracted\world\$($progress.runId)"
& py -3 (Join-Path $Tools 'package_world.py') --source $progress.stage --destination $packaged --public-root (Join-Path $project 'public\extracted') --workers 4
if ($LASTEXITCODE -ne 0) { throw 'Lossless world packaging failed; resume with the same run ID.' }
& $Node (Join-Path $PSScriptRoot 'verify-extracted.mjs') "--root=$packaged"
if ($LASTEXITCODE -ne 0) { throw 'Packaged map verification failed.' }
& $Node (Join-Path $PSScriptRoot 'verify-world.mjs') "--root=$packaged" "--connections=$graph"
if ($LASTEXITCODE -ne 0) { throw 'Packaged connection verification failed.' }
if (!$NoPublish) {
  & $Node (Join-Path $PSScriptRoot 'publish-world.mjs') "--root=$packaged"
  if ($LASTEXITCODE -ne 0) { throw 'World publication failed.' }
}
Write-Host "Verified world: $packaged"
