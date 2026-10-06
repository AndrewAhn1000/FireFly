$ErrorActionPreference = 'Stop'
$Root    = Split-Path $PSScriptRoot -Parent
$Version = '1.20.1'
$ZipName = "onnxruntime-win-x64-$Version.zip"
$ZipPath = Join-Path $Root $ZipName
$OutDir  = Join-Path $Root 'native\libs\onnxruntime'

Write-Host "==> Setting up ONNX Runtime $Version"
Write-Host "    Target: $OutDir"

# 1. Download
$Url = "https://github.com/microsoft/onnxruntime/releases/download/v$Version/$ZipName"
if (-not (Test-Path $ZipPath)) {
    Write-Host "    Downloading $ZipName ..."
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath
}

# 2. Extract to a temp location, then normalize to target layout
$TmpDir = Join-Path $Root 'native\libs\_ort_tmp'
if (Test-Path $TmpDir) { Remove-Item $TmpDir -Recurse -Force }
Write-Host "    Extracting..."
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir

# The zip contains a single subfolder named onnxruntime-win-x64-X.Y.Z
$Inner = Get-ChildItem $TmpDir -Directory | Select-Object -First 1

# 3. Move to final location
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
Move-Item $Inner.FullName $OutDir
Remove-Item $TmpDir -Recurse -Force

# 4. Normalise: move DLLs from lib/ root or top-level into lib/
#    Different ORT versions place DLLs in different spots — normalise to lib/
$LibDir = Join-Path $OutDir 'lib'
if (-not (Test-Path $LibDir)) { New-Item -ItemType Directory $LibDir | Out-Null }
foreach ($dll in (Get-ChildItem $OutDir -Filter '*.dll' -File)) {
    $Dest = Join-Path $LibDir $dll.Name
    if (-not (Test-Path $Dest)) { Move-Item $dll.FullName $Dest }
}

Write-Host ""
Write-Host "==> ONNX Runtime $Version installed to native/libs/onnxruntime"
Write-Host "    Run 'npm run native:configure && npm run native:build' to rebuild."
Write-Host "    Cleaning download zip..."
Remove-Item $ZipPath -ErrorAction SilentlyContinue
