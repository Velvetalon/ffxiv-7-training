[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'toolchain.ps1')
Set-MapToolsDotnetEnvironment -Root $PSScriptRoot
$dotnet = Get-MapToolsDotnet -Root $PSScriptRoot
$dll = Join-Path $PSScriptRoot 'bin\MapExtract.dll'
if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) {
  throw "MapExtract is not built. Run $PSScriptRoot\build.ps1 first."
}
& $dotnet $dll @Arguments
exit $LASTEXITCODE
