$ErrorActionPreference = 'Stop'
$Root      = Split-Path $PSScriptRoot -Parent
$BundleDir = Join-Path $Root 'python-bundle'
$ZipPath   = Join-Path $Root 'python-embed.zip'

Write-Host "==> Setting up python-bundle in $BundleDir"

# 1. Download Python 3.12 embeddable
$PyUrl = 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-embed-amd64.zip'
if (-not (Test-Path $ZipPath)) {
    Write-Host "    Downloading Python embeddable..."
    Invoke-WebRequest -Uri $PyUrl -OutFile $ZipPath
}

# 2. Extract
if (Test-Path $BundleDir) { Remove-Item $BundleDir -Recurse -Force }
Write-Host "    Extracting..."
Expand-Archive -Path $ZipPath -DestinationPath $BundleDir

# 3. Enable site-packages (required for pip to work)
$PthFile = Get-Item "$BundleDir\python312._pth"
$content = Get-Content $PthFile.FullName -Raw
$content = $content -replace '#import site', 'import site'
Set-Content $PthFile.FullName $content -NoNewline

# 4. Bootstrap pip
Write-Host "    Installing pip..."
$GetPip = Join-Path $BundleDir 'get-pip.py'
Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $GetPip
& "$BundleDir\python.exe" $GetPip --no-warn-script-location
Remove-Item $GetPip

# 5. Install ML packages (CPU PyTorch — GPU users upgrade in-app)
Write-Host "    Installing packages (this may take a few minutes)..."
& "$BundleDir\python.exe" -m pip install `
    torch torchvision `
    --index-url https://download.pytorch.org/whl/cpu `
    --no-warn-script-location
& "$BundleDir\python.exe" -m pip install `
    Pillow numpy `
    --no-warn-script-location

# 6. Clean up download cache to save space
$Cache = Join-Path $BundleDir 'Scripts\..\..\pip-cache' # not usually here
& "$BundleDir\python.exe" -m pip cache purge 2>$null

Write-Host ""
Write-Host "==> python-bundle ready ($BundleDir)"
Write-Host "    Run 'npm run package' to build the distributable."
