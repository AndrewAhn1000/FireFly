$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$baseline = '319504a5326aa870edde46438c5455fa76305a56'
if (-not (Test-Path '.tools/vcpkg/vcpkg.exe')) {
    if (-not (Test-Path '.tools/vcpkg/.git')) {
        & git clone --depth 1 https://github.com/microsoft/vcpkg.git .tools/vcpkg
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
    & git -C .tools/vcpkg fetch --depth 1 origin $baseline
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    & git -C .tools/vcpkg checkout --detach $baseline
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    & ./.tools/vcpkg/bootstrap-vcpkg.bat -disableMetrics
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
