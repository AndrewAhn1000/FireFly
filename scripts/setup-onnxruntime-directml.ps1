$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$Cache = Join-Path $Root 'native\libs\directml-packages'
$OutDir = Join-Path $Root 'native\libs\onnxruntime-directml'
New-Item -ItemType Directory -Force -Path $Cache, "$OutDir\include", "$OutDir\lib" | Out-Null
function Get-Package([string]$Name, [string]$Version) {
    $Archive = Join-Path $Cache "$Name.$Version.zip"
    $Expanded = Join-Path $Cache "$Name.$Version"
    if (-not (Test-Path -LiteralPath $Archive)) {
        Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/$Name/$Version/$Name.$Version.nupkg" -OutFile $Archive
    }
    if (-not (Test-Path -LiteralPath $Expanded)) { Expand-Archive -LiteralPath $Archive -DestinationPath $Expanded }
    return $Expanded
}
# Match the existing CPU runtime ABI; install separately so switching back is reversible.
$OrtPackage = Get-Package 'microsoft.ml.onnxruntime.directml' '1.20.1'
$DmlPackage = Get-Package 'microsoft.ai.directml' '1.15.2'
Copy-Item -Path "$OrtPackage\build\native\include\*" -Destination "$OutDir\include" -Force
Copy-Item -Path "$DmlPackage\include\*" -Destination "$OutDir\include" -Force
Copy-Item -Path "$OrtPackage\runtimes\win-x64\native\*" -Destination "$OutDir\lib" -Force
Copy-Item -LiteralPath "$DmlPackage\bin\x64-win\DirectML.dll" -Destination "$OutDir\lib\DirectML.dll" -Force
Copy-Item -Path "$OrtPackage\*.txt", "$DmlPackage\*.txt" -Destination $OutDir -Force
Copy-Item -LiteralPath "$OrtPackage\LICENSE" -Destination "$OutDir\LICENSE-ORT" -Force
Write-Host 'DirectML inference runtime installed. Run npm run native:configure and npm run native:build.'
