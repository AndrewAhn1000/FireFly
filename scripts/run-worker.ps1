param([string]$DataDirectory)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if (-not $DataDirectory) { $DataDirectory=Join-Path $env:APPDATA 'firefly/data' }
& ./.venv/Scripts/python.exe -u worker/worker.py --root $DataDirectory
exit $LASTEXITCODE
