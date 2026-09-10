[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Client,
  [string]$Output = (Join-Path $PSScriptRoot '..\..\public\sandbox\audio\action-source-manifest.json'),
  [string]$LuminaRoot = '',
  [string]$Dotnet = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Dotnet) { $Dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)?.Source; if (-not $Dotnet) { $Dotnet = 'dotnet' } }
if (-not $LuminaRoot) { $LuminaRoot = Join-Path $repo '..\..\..\FFXIV-MapTools\Lumina' }
$project = Join-Path $PSScriptRoot 'ActionProbe.csproj'
$buildArgs = @('build',$project,('/p:LuminaRoot=' + $LuminaRoot),'-v:q')
& $Dotnet @buildArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Action probe build failed.' }
$dll = Join-Path $PSScriptRoot 'bin\Debug\net10.0\ActionProbe.dll'
& $Dotnet $dll $Client (Join-Path $PSScriptRoot 'action-names.json') ([IO.Path]::GetFullPath($Output))
if ($LASTEXITCODE -ne 0) { throw 'Action EXD probe failed.' }
