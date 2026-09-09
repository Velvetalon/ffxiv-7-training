param([int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$nodeMajor = [int]((& $node -p 'process.versions.node.split(".")[0]') | Select-Object -Last 1)
if ($nodeMajor -lt 18) { throw '需要 Node.js 18 或更高版本；推荐 Node.js 22。' }
if (!(Test-Path -LiteralPath (Join-Path $project 'node_modules\vite\bin\vite.js'))) {
  Push-Location $project
  try { npm install --cache .\work\npm-cache }
  finally { Pop-Location }
}
Write-Host "以太演武场: http://127.0.0.1:$Port"
& $node (Join-Path $project 'node_modules\vite\bin\vite.js') $project --host 127.0.0.1 --port $Port --strictPort
