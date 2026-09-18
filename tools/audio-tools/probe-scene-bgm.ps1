[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Client,
  [string]$Output = (Join-Path $PSScriptRoot '..\..\public\sandbox\audio\scene-bgm-catalog.json'),
  [string]$Catalog = (Join-Path $repo 'tools\map-tools\world-catalog.json'),
  [string]$LuminaRoot = '',
  [string]$Dotnet = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Dotnet) { $Dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)?.Source; if (-not $Dotnet) { $Dotnet = 'dotnet' } }
if (-not $LuminaRoot) { $LuminaRoot = Join-Path $repo '..\..\..\FFXIV-MapTools\Lumina' }
$project = Join-Path $PSScriptRoot 'SceneBgmProbe.csproj'
$catalog = [IO.Path]::GetFullPath($Catalog)
$buildArgs = @('build',$project,('/p:LuminaRoot=' + $LuminaRoot),'-v:q')
& $Dotnet @buildArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Scene BGM probe build failed.' }
$dll = Join-Path $PSScriptRoot 'bin\Debug\net10.0\SceneBgmProbe.dll'
& $Dotnet $dll $Client $catalog ([IO.Path]::GetFullPath($Output))
if ($LASTEXITCODE -ne 0) { throw 'Scene BGM probe failed.' }
