$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.venv/Scripts/python.exe')) { & py -3.12 -m venv .venv; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
# The lock file has the CPU build of PyTorch. A CUDA build installed since (as the Train tab shows how) is kept:
# installing the lock file as it is would swap it back, and training would quietly move to the CPU.
$requirements = 'worker/requirements.lock.txt'
$torch = & ./.venv/Scripts/python.exe -c "import importlib.metadata as m; print(next((d.version for d in m.distributions() if d.metadata['Name'] == 'torch'), ''))"
if ($torch -match '\+cu') {
    Write-Host "Keeping the CUDA build of PyTorch ($torch)"
    $requirements = Join-Path ([IO.Path]::GetTempPath()) 'firefly-requirements-cuda.txt'
    Get-Content 'worker/requirements.lock.txt' | Where-Object { $_ -notmatch '^torch==' } | Set-Content -Encoding ascii $requirements
}
& ./.venv/Scripts/python.exe -m pip install -r $requirements --extra-index-url https://download.pytorch.org/whl/cpu
exit $LASTEXITCODE
