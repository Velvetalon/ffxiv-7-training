[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Client,
  [Parameter(Mandatory)][string[]]$Scene,
  [string]$Output = (Join-Path $PSScriptRoot '..\..\public\sandbox\audio'),
  [string]$MapExtract = (Join-Path $PSScriptRoot '..\map-tools\MapExtract.cmd'),
  [string]$LuminaRoot = '',
  [string]$Dotnet = '',
  [string[]]$SfxPath = @(),
  [string]$VGAudio = '',
  [string]$OggEnc = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$catalog = Get-Content -Raw (Join-Path $repo 'tools\map-tools\world-catalog.json') | ConvertFrom-Json
$sceneBgmCatalogPath = Join-Path $repo 'public\sandbox\audio\scene-bgm-catalog.json'
if (Test-Path -LiteralPath $sceneBgmCatalogPath) {
  $sceneBgm = [ordered]@{ scenes = [ordered]@{} }
  $sceneBgmCatalog = Get-Content -Raw $sceneBgmCatalogPath | ConvertFrom-Json
  foreach ($item in $sceneBgmCatalog.Scenes) {
    $sceneBgm.scenes[$item.SceneId] = [ordered]@{
      territoryId = $item.TerritoryId
      bgmSituationId = $item.BgmSituationId
      bgmId = $item.DaytimeBgmId
      scdPath = $item.DayPath
      status = $item.Status
    }
  }
} else {
  $sceneBgm = Get-Content -Raw (Join-Path $PSScriptRoot 'scene-bgm.json') | ConvertFrom-Json
}
$output = [IO.Path]::GetFullPath($Output)
$stage = Join-Path $repo 'work\audio-extract'
New-Item -ItemType Directory -Force -Path $output,$stage | Out-Null

if (-not $Dotnet) {
  $Dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)?.Source
  if (-not $Dotnet) { $Dotnet = 'dotnet' }
}
if (-not $LuminaRoot) {
  $LuminaRoot = Join-Path $repo '..\..\..\FFXIV-MapTools\Lumina'
}
$luminaProject = Join-Path $LuminaRoot 'src\Lumina\Lumina.csproj'
if (-not (Test-Path -LiteralPath $luminaProject)) {
  throw "Lumina checkout not found: $LuminaRoot. Pass -LuminaRoot explicitly."
}
if (-not (Test-Path -LiteralPath $MapExtract)) { throw "MapExtract.cmd not found: $MapExtract" }

$project = Join-Path $PSScriptRoot 'ScdExtract.csproj'
$buildArgs = @('build',$project,('/p:LuminaRoot=' + $LuminaRoot),'-v:q')
& $Dotnet @buildArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'SCD extractor build failed.' }
$scdDll = Join-Path $PSScriptRoot 'bin\Debug\net10.0\ScdExtract.dll'
$aggregate = [ordered]@{
  SchemaVersion = 1
  Source = [ordered]@{ Library = 'Lumina'; LibraryVersion = '2.4.2'; Method = 'MapExtract.cmd raw + Lumina SCD parser'; Client = 'provided via -Client (not embedded)' }
  SceneBgm = [ordered]@{}
  Resources = [ordered]@{}
  References = @()
  Errors = @()
}
foreach ($sceneId in $Scene) {
  $record = $catalog.scenes | Where-Object id -eq $sceneId | Select-Object -First 1
  if (-not $record) { throw "Unknown scene '$sceneId' (must be in world-catalog.json)." }
  $soundLgb = Join-Path $stage "$sceneId-sound.lgb"
  $virtual = "$($record.root)/level/sound.lgb"
  & $MapExtract raw $Client $virtual $soundLgb
  if ($LASTEXITCODE -ne 0) { throw "MapExtract raw failed for $sceneId ($virtual)." }
  $bgm = $sceneBgm.scenes.$sceneId
  $bgmRaw = $null
  if ($bgm) {
    $bgmRaw = Join-Path $stage "$sceneId-bgm.scd"
    & $MapExtract raw $Client $bgm.scdPath $bgmRaw
    if ($LASTEXITCODE -ne 0) { throw "MapExtract raw failed for BGM $sceneId ($($bgm.scdPath))." }
  }
  $runArgs = @($scdDll,$Client,$soundLgb,$output,$sceneId)
  if ($bgm) { $runArgs += @('--scd',$bgm.scdPath) }
  foreach ($sfx in $SfxPath) { $runArgs += @('--scd',$sfx) }
  if ($VGAudio) { $runArgs += @('--vgaudio',$VGAudio) }
  if ($OggEnc) { $runArgs += @('--oggenc',$OggEnc) }
  & $Dotnet @runArgs
  if ($LASTEXITCODE -ne 0) { throw "SCD extraction failed for $sceneId." }
  $manifestPath = Join-Path $output 'audio-source-manifest.json'
  $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
  foreach ($property in $manifest.Resources.PSObject.Properties) { $aggregate.Resources[$property.Name] = $property.Value }
  $aggregate.References += @($manifest.References)
  $aggregate.Errors += @($manifest.Errors)
  foreach ($property in $manifest.SceneBgm.PSObject.Properties) { $aggregate.SceneBgm[$property.Name] = $property.Value }
  if ($bgm) {
    $bgmResource = @($manifest.Resources.PSObject.Properties | Where-Object { $_.Value.Source.ScdPath -eq $bgm.scdPath } | Select-Object -First 1).Value
    $manifest.SceneBgm.$sceneId = [ordered]@{
      Id = if ($bgmResource) { $bgmResource.Id } else { $null }
      Status = if ($bgmResource) { 'Confirmed from TerritoryType -> BGMSituation -> BGM -> SCD' } else { $bgm.status }
      Evidence = [ordered]@{
        territoryId = [int]$bgm.territoryId
        bgmSituationId = [int]$bgm.bgmSituationId
        bgmId = [int]$bgm.bgmId
        scdPath = $bgm.scdPath
        rawPath = (Join-Path 'work/audio-extract' "$sceneId-bgm.scd")
      }
    }
    $aggregate.SceneBgm[$sceneId] = $manifest.SceneBgm.$sceneId
  }
}
# SceneBgm is a strict TerritoryType/BGMSituation/BGM mapping. Never carry a
# sound.lgb ambience candidate into this table.
$aggregate.SceneBgm = [ordered]@{}
foreach ($sceneId in $Scene) {
  $bgm = $sceneBgm.scenes.$sceneId
  if (-not $bgm) { continue }
  $bgmResource = @($aggregate.Resources.Values | Where-Object { $_.Source.ScdPath -eq $bgm.scdPath } | Select-Object -First 1)
  $aggregate.SceneBgm[$sceneId] = [ordered]@{
    Id = if ($bgmResource) { $bgmResource[0].Id } else { $null }
    Status = if ($bgmResource) { 'Confirmed from TerritoryType -> BGMSituation -> BGM -> SCD' } else { $bgm.status }
    Evidence = [ordered]@{
      territoryId = [int]$bgm.territoryId
      bgmSituationId = [int]$bgm.bgmSituationId
      bgmId = [int]$bgm.bgmId
      scdPath = $bgm.scdPath
      rawPath = (Join-Path 'work/audio-extract' "$sceneId-bgm.scd")
    }
  }
}
$aggregate | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8 (Join-Path $output 'audio-source-manifest.json')
Write-Output "Audio extraction complete: $output"
