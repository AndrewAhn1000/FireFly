$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.venv/Scripts/python.exe')) { & py -3.12 -m venv .venv; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
& ./.venv/Scripts/python.exe -m pip install -r worker/requirements.lock.txt --extra-index-url https://download.pytorch.org/whl/cpu
exit $LASTEXITCODE
