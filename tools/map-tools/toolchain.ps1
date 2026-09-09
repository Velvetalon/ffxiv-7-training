Set-StrictMode -Version Latest

function Test-MapToolsDotnet10 {
  param([Parameter(Mandatory)][string]$Path)
  try {
    $sdks = & $Path --list-sdks 2>$null
    return [bool]($sdks | Where-Object { $_ -match '^\s*(1[0-9]|[2-9][0-9])\.\d+\.\d+\s+\[' } | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Get-MapToolsDotnet {
  param([Parameter(Mandatory)][string]$Root)
  $portable = Join-Path $Root 'dotnet\dotnet.exe'
  if ((Test-Path -LiteralPath $portable -PathType Leaf) -and (Test-MapToolsDotnet10 $portable)) {
    return (Resolve-Path -LiteralPath $portable).Path
  }
  $onPath = Get-Command dotnet -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath -and (Test-MapToolsDotnet10 $onPath.Source)) {
    return $onPath.Source
  }
  throw '.NET SDK 10+ is required. Provide dotnet\dotnet.exe or install a .NET 10 SDK on PATH.'
}

function Set-MapToolsDotnetEnvironment {
  param([Parameter(Mandatory)][string]$Root)
  $env:DOTNET_CLI_HOME = Join-Path $Root '.dotnet-home'
  $env:NUGET_PACKAGES = Join-Path $Root 'nuget'
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
}
