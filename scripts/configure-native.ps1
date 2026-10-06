$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.tools/vcpkg/vcpkg.exe')) { throw 'Run scripts/setup-native.ps1 first.' }
# OpenCV's pkg-config lookup requires a tool download path without spaces.
$env:VCPKG_DOWNLOADS = Join-Path ([IO.Path]::GetTempPath()) 'firefly-vcpkg-downloads'
if ($env:VCPKG_DOWNLOADS.Contains(' ')) { throw 'Set a TEMP directory without spaces before configuring OpenCV.' }
New-Item -ItemType Directory -Force -Path $env:VCPKG_DOWNLOADS | Out-Null
$toolchain = Join-Path (Get-Location) '.tools/vcpkg/scripts/buildsystems/vcpkg.cmake'
$installed = Join-Path (Get-Location) 'build/vcpkg_installed'
& cmake --fresh -S native -B build/native -A x64 "-DCMAKE_TOOLCHAIN_FILE=$toolchain" "-DVCPKG_INSTALLED_DIR=$installed" -DVCPKG_MANIFEST_INSTALL=ON
exit $LASTEXITCODE
