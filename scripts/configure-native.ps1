$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.tools/vcpkg/vcpkg.exe')) { throw 'Run scripts/setup-native.ps1 first.' }
# vcpkg's downloaded tools, kept out of TEMP: Windows' Storage Sense empties old files there but leaves their
# folders, and vcpkg takes a tool's folder to mean it's still there. OpenCV's pkg-config lookup needs a path
# without spaces, so a user name with a space gets the folder's short name.
$downloads = if ($env:VCPKG_DOWNLOADS) { $env:VCPKG_DOWNLOADS } else { Join-Path $env:LOCALAPPDATA 'firefly-vcpkg-downloads' }
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
if ($downloads.Contains(' ')) { $downloads = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($downloads).ShortPath }
if ($downloads.Contains(' ')) { throw "vcpkg's download folder ($downloads) has a space in its path, which OpenCV can't build from. Set VCPKG_DOWNLOADS to a folder without one, such as C:\vcpkg-downloads." }
$env:VCPKG_DOWNLOADS = $downloads
$toolchain = Join-Path (Get-Location) '.tools/vcpkg/scripts/buildsystems/vcpkg.cmake'
$installed = Join-Path (Get-Location) 'build/vcpkg_installed'
& cmake --fresh -S native -B build/native -A x64 "-DCMAKE_TOOLCHAIN_FILE=$toolchain" "-DVCPKG_INSTALLED_DIR=$installed" -DVCPKG_MANIFEST_INSTALL=ON
exit $LASTEXITCODE
