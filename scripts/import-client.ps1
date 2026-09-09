param(
  [string]$Client = 'G:\WeGameApps\rail_apps\ffxiv(2000340)',
  [string]$Tools = 'G:\FFXIV-MapTools'
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath (Join-Path $Client 'game\sqpack'))) { throw 'Client game/sqpack directory does not exist.' }
& (Join-Path $Tools 'build.ps1')
if ($LASTEXITCODE -ne 0) { throw 'MapExtract build failed.' }
foreach ($scene in @('gridania','limsa')) {
  $output = Join-Path $Tools "exports\$scene"
  & (Join-Path $Tools 'MapExtract.cmd') extract-map $Client $scene $output
  if ($LASTEXITCODE -ne 0) { throw "$scene extraction failed." }
  & (Join-Path $Tools 'MapExtract.cmd') collision-map $Client $scene $output
  if ($LASTEXITCODE -ne 0) { throw "$scene collision extraction failed." }
  & (Join-Path $Tools 'MapExtract.cmd') model-folder $output
  if ($LASTEXITCODE -ne 0) { throw "$scene GLB conversion failed." }
  $mapPath = if ($scene -eq 'gridania') { 'ui/map/f1t1/00/f1t100_m.tex' } else { 'ui/map/s1t2/01/s1t201_m.tex' }
  & (Join-Path $Tools 'MapExtract.cmd') raw $Client $mapPath (Join-Path $output $mapPath)
  if ($LASTEXITCODE -ne 0) { throw "$scene minimap extraction failed." }
}
& python (Join-Path $Tools 'assemble_scene.py') gridania limsa
if ($LASTEXITCODE -ne 0) { throw 'Scene assembly failed.' }
& python (Join-Path $Tools 'collision_mesh.py') gridania limsa
if ($LASTEXITCODE -ne 0) { throw 'Collision conversion failed.' }
Write-Host 'Local client maps prepared. Run npm run verify:extracted next.'
