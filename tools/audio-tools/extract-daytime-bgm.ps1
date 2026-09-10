[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Client,
  [string]$Output = (Join-Path $PSScriptRoot '..\..\public\sandbox\audio'),
  [string]$MapExtract = (Join-Path $PSScriptRoot '..\map-tools\MapExtract.cmd'),
  [string]$LuminaRoot = '',
  [string]$Dotnet = '',
  [string]$VGAudio = '',
  [string]$OggEnc = '',
  [string[]]$SfxPath = @()
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$catalogPath = Join-Path $repo 'public\sandbox\audio\scene-bgm-catalog.json'
if (-not (Test-Path -LiteralPath $catalogPath)) { throw "Run probe-scene-bgm.ps1 first: $catalogPath" }
$catalog = Get-Content -Raw $catalogPath | ConvertFrom-Json
$output = [IO.Path]::GetFullPath($Output)
$stage = Join-Path $repo 'work\audio-extract'
New-Item -ItemType Directory -Force -Path $output,$stage | Out-Null
if (-not $Dotnet) { $Dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)?.Source; if (-not $Dotnet) { $Dotnet = 'dotnet' } }
if (-not $LuminaRoot) { $LuminaRoot = Join-Path $repo '..\..\..\FFXIV-MapTools\Lumina' }
$project = Join-Path $PSScriptRoot 'ScdExtract.csproj'
$buildArgs = @('build',$project,('/p:LuminaRoot=' + $LuminaRoot),'-v:q')
& $Dotnet @buildArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'SCD extractor build failed.' }
$scdDll = Join-Path $PSScriptRoot 'bin\Debug\net10.0\ScdExtract.dll'
if (-not (Test-Path -LiteralPath $MapExtract)) { throw "MapExtract.cmd not found: $MapExtract" }

$paths = @($catalog.Scenes | ForEach-Object DayPath | Where-Object { $_ } | Sort-Object -Unique)
$soundLgb = Join-Path $stage 'gridania-sound.lgb'
if (-not (Test-Path -LiteralPath $soundLgb)) {
  $gridania = $catalog.Scenes | Where-Object SceneId -eq 'gridania' | Select-Object -First 1
  & $MapExtract raw $Client "bg/ffxiv/fst_f1/twn/f1t1/level/sound.lgb" $soundLgb
  if ($LASTEXITCODE -ne 0) { throw 'Unable to obtain the probe sound.lgb.' }
}
foreach ($path in $paths) {
  $name = [IO.Path]::GetFileName($path)
  & $MapExtract raw $Client $path (Join-Path $stage $name)
  if ($LASTEXITCODE -ne 0) { throw "MapExtract raw failed for $path" }
}

$runArgs = @($scdDll,$Client,$soundLgb,$output,'bgm-batch')
foreach ($path in $paths) { $runArgs += @('--scd',$path) }
foreach ($path in $SfxPath) { $runArgs += @('--scd',$path) }
if ($VGAudio) { $runArgs += @('--vgaudio',$VGAudio) }
if ($OggEnc) { $runArgs += @('--oggenc',$OggEnc) }
& $Dotnet @runArgs
if ($LASTEXITCODE -ne 0) { throw 'BGM batch SCD conversion failed.' }

$raw = Get-Content -Raw (Join-Path $output 'audio-source-manifest.json') | ConvertFrom-Json
$resources = [ordered]@{}
foreach ($property in $raw.Resources.PSObject.Properties) {
  if ($property.Value.Source.ScdPath -like 'music/*' -or $property.Value.Source.ScdPath -like 'sound/vfx/ability/*') {
    $resources[$property.Name] = $property.Value
  }
}
$sceneBgm = [ordered]@{}
foreach ($scene in $catalog.Scenes) {
  $resource = @($resources.Values | Where-Object { $_.Source.ScdPath -eq $scene.DayPath } | Select-Object -First 1)
  $isNullBgm = $scene.DayPath -eq 'music/ffxiv/BGM_Null.scd'
  $sceneBgm[$scene.SceneId] = [ordered]@{
    Id = if ($resource) { $resource[0].Id } else { $null }
    Status = if ($resource) { 'Confirmed from installed EXH/EXD BGM chain and SCD' } elseif ($isNullBgm) { 'Confirmed BGM_Null: no playback resource' } else { 'Unknown: SCD conversion missing' }
    Evidence = [ordered]@{ territoryId = $scene.TerritoryId; bgmSituationId = $scene.BgmSituationId; bgmId = $scene.DaytimeBgmId; scdPath = $scene.DayPath }
  }
}
$aggregate = [ordered]@{
  SchemaVersion = 1
  Source = [ordered]@{ Library = 'Lumina + VFXEditor VGAudio'; Method = 'MapExtract.cmd raw; one unique daytime-SCD batch'; UniqueDaytimeSCD = $paths.Count; Client = 'provided via -Client (not embedded)' }
  SceneBgm = $sceneBgm
  Resources = $resources
  References = @()
  Errors = @($raw.Errors)
}
$aggregate | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8 (Join-Path $output 'audio-source-manifest.json')
$keep = @($resources.Values | ForEach-Object { [IO.Path]::GetFileName($_.Path) }) + @('audio-source-manifest.json','action-source-manifest.json','scene-bgm-catalog.json')
Get-ChildItem -LiteralPath $output -File | Where-Object { $keep -notcontains $_.Name } | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
Write-Output "Daytime BGM batch complete: scenes=$(@($catalog.Scenes).Count) uniqueSCD=$($paths.Count) resources=$(@($resources.Keys).Count)"
