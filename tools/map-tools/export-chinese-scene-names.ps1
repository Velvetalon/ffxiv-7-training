[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$Client = $env:FFXIV_CLIENT,
  [Parameter(Mandatory = $false)][string]$Project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [Parameter(Mandatory = $false)][string]$Dotnet
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Client)) { throw 'Provide -Client or set FFXIV_CLIENT.' }
. (Join-Path $PSScriptRoot 'toolchain.ps1')
Set-MapToolsDotnetEnvironment -Root $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Dotnet)) { $Dotnet = Get-MapToolsDotnet -Root $PSScriptRoot }
$catalog = Join-Path $Project 'tools\map-tools\world-catalog.json'
$data = Join-Path $Project 'tools\map-tools\data'
$metadata = Join-Path $data 'world-scene-names-zh.json'
$names = Join-Path $data 'world-names-zh.json'
$regions = Join-Path $data 'world-regions-zh.json'
$projectFile = Join-Path $PSScriptRoot 'MapNameProbe\MapNameProbe.csproj'
& $Dotnet run --project $projectFile -c Release -- --client=$Client --catalog=$catalog --metadata-out=$metadata --names-out=$names --regions-out=$regions
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
