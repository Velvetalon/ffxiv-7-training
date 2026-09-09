param(
  [ValidateRange(1024, 65535)][int]$Port = 5173,
  [switch]$NoBrowser,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$logDirectory = Join-Path $project 'work'

function Test-TrainingServer([string]$Address) {
  try {
    $response = Invoke-WebRequest -Uri $Address -UseBasicParsing -TimeoutSec 2
    return $response.Content -match '<title>[^<]*Aetheryte</title>'
  } catch {
    return $false
  }
}

try {
  [void][System.IO.Directory]::CreateDirectory($logDirectory)
  $url = "http://127.0.0.1:$Port/"
  $running = Test-TrainingServer $url

  if (!$running) {
    # Leave unrelated services alone and choose the next available port.
    while (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
      if ($Port -eq 65535) { throw '没有可用的启动端口。' }
      $Port++
    }
    $url = "http://127.0.0.1:$Port/"
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    $node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
    $nodeVersion = & $node --version
    $nodeMajor = [int]($nodeVersion -replace '^v(\d+).*$', '$1')
    if ($nodeMajor -lt 18) { throw '需要 Node.js 18 或更高版本；推荐 Node.js 22。' }
    $vite = Join-Path $project 'node_modules\vite\bin\vite.js'
    if (!(Test-Path -LiteralPath $vite)) {
      Write-Host '正在安装项目依赖，请稍候……'
      $npmDirectory = Split-Path (Get-Command npm.cmd -ErrorAction Stop).Source
      $npmCli = Join-Path $npmDirectory 'node_modules\npm\bin\npm-cli.js'
      Push-Location $project
      try {
        & $node $npmCli install --cache (Join-Path $logDirectory 'npm-cache')
        if ($LASTEXITCODE -ne 0) { throw "安装依赖失败，退出码 $LASTEXITCODE。" }
      } finally {
        Pop-Location
      }
    }

    $stdout = Join-Path $logDirectory "server-$Port.stdout.log"
    $stderr = Join-Path $logDirectory "server-$Port.stderr.log"
    $serverArguments = @(('"' + $vite + '"'), ('"' + $project + '"'), '--host', '127.0.0.1', '--port', "$Port", '--strictPort')
    $server = Start-Process -FilePath $node -ArgumentList $serverArguments -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if (Test-TrainingServer $url) { $running = $true; break }
      if ($server.HasExited) { break }
      Start-Sleep -Milliseconds 250
    }
    if (!$running) {
      $detail = Get-Content -LiteralPath $stderr -Tail 15 -ErrorAction SilentlyContinue
      throw "服务未能就绪。日志：$stdout；$stderr`n$($detail -join [Environment]::NewLine)"
    }
    Write-Host "服务已启动，进程 $($server.Id)。"
  } else {
    Write-Host '演武场已在运行，直接打开现有服务。'
  }

  Write-Host "以太演武场：$url" -ForegroundColor Green
  if (!$NoBrowser) { Start-Process -FilePath $url }
} catch {
  $message = "启动失败：$($_.Exception.Message)"
  Write-Host $message -ForegroundColor Red
  if (Test-Path -LiteralPath $logDirectory) {
    $message | Out-File -LiteralPath (Join-Path $logDirectory 'startup-error.log') -Encoding utf8
  }
  if (!$NoPause) { [void](Read-Host '请保留此错误信息，按 Enter 关闭窗口') }
  exit 1
}
