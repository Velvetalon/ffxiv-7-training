$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'toolchain.ps1')
Set-MapToolsDotnetEnvironment -Root $PSScriptRoot
$dotnet = Get-MapToolsDotnet -Root $PSScriptRoot
& $dotnet build (Join-Path $PSScriptRoot 'MapExtract\MapExtract.csproj') -c Release -o (Join-Path $PSScriptRoot 'bin') -p:RestoreLockedMode=true
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
