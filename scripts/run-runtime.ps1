$ErrorActionPreference = 'Stop'
$runtime = Join-Path (Split-Path $PSScriptRoot -Parent) 'build\native\Release\firefly-runtime.exe'
if (-not (Test-Path -LiteralPath $runtime)) { throw 'Build first: run scripts/setup-native.ps1, then scripts/configure-native.ps1, then: cmake --build build/native --config Release' }
& $runtime
exit $LASTEXITCODE
