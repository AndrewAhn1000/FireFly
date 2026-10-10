# Sets up a development copy of FireFly in one go: checks the tools it needs, then installs the JavaScript
# packages, builds the native runtime with ONNX Runtime (DirectML, which runs models on the GPU or the CPU)
# and makes the Python .venv. Each step is one of the npm scripts, so any of them can be run again on its own.
#   npm run setup                      everything
#   npm run setup -- -Check            only check the tools
#   npm run setup -- -Install          install missing tools with winget first
#   npm run setup -- -SkipPython       leave out the Python .venv
param([switch]$Check, [switch]$Install, [switch]$SkipPython)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

# A tool installed after this terminal was opened isn't on its PATH yet: read PATH again as Windows has it now
function Update-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($env:Path -split ';') + @($machine -split ';') + @($user -split ';') | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
function Find-VisualStudio {
    if (-not (Test-Path $vswhere)) { return $null }
    $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($path) { return $path } else { return $null }
}

function Find-Tools {
    Update-Path
    $vs = Find-VisualStudio
    # CMake from its own installer, or else the one that comes with Visual Studio's C++ tools
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue) -and $vs) {
        $bundled = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
        if (Test-Path (Join-Path $bundled 'cmake.exe')) { $env:Path = "$bundled;$env:Path" }
    }
    $cmakeVersion = $null
    if (Get-Command cmake -ErrorAction SilentlyContinue) {
        if ((& cmake --version | Select-Object -First 1) -match '(\d+\.\d+(\.\d+)?)') { $cmakeVersion = [version]$Matches[1] }
    }
    $nodeVersion = $null
    if (Get-Command node -ErrorAction SilentlyContinue) { $nodeVersion = [version]((& node --version).TrimStart('v')) }
    $python = $false
    if (Get-Command py -ErrorAction SilentlyContinue) { & py -3.12 --version *> $null; $python = $LASTEXITCODE -eq 0 }
    [ordered]@{
        'Node.js 20 or newer' = @{ ok = $nodeVersion -and $nodeVersion.Major -ge 20; found = $nodeVersion; winget = 'OpenJS.NodeJS.LTS' }
        'Git' = @{ ok = [bool](Get-Command git -ErrorAction SilentlyContinue); winget = 'Git.Git' }
        'CMake 3.24 or newer' = @{ ok = $cmakeVersion -and $cmakeVersion -ge [version]'3.24'; found = $cmakeVersion; winget = 'Kitware.CMake' }
        'Visual Studio C++ build tools' = @{ ok = [bool]$vs; found = $vs; winget = 'Microsoft.VisualStudio.2022.BuildTools'
            override = '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' }
        'Python 3.12 (py -3.12)' = @{ ok = $python -or $SkipPython; winget = 'Python.Python.3.12' }
    }
}

function Show-Tools($tools) {
    Write-Host '==> Tools'
    foreach ($name in $tools.Keys) {
        $t = $tools[$name]
        if ($t.ok) { $line = "    ok       $name"; if ($t.found) { $line += " ($($t.found))" }; Write-Host $line -ForegroundColor Green }
        else { $line = "    missing  $name"; if ($t.found) { $line += " (found $($t.found))" }; Write-Host $line -ForegroundColor Red }
    }
}

$tools = Find-Tools
Show-Tools $tools
$missing = @($tools.Keys | Where-Object { -not $tools[$_].ok })
if ($missing.Count -and $Install) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is not available: install the missing tools by hand (see the README).' }
    foreach ($name in $missing) {
        $t = $tools[$name]
        Write-Host "==> Installing $name"
        $wingetArgs = @('install', '--id', $t.winget, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
        if ($t.override) { $wingetArgs += @('--override', $t.override) }
        & winget @wingetArgs
        if ($LASTEXITCODE) { Write-Warning "winget could not install $name (exit $LASTEXITCODE)" }
    }
    $tools = Find-Tools
    Show-Tools $tools
    $missing = @($tools.Keys | Where-Object { -not $tools[$_].ok })
}
if ($missing.Count) {
    Write-Host ''
    Write-Host 'Install what is missing, then run npm run setup again. With winget:' -ForegroundColor Yellow
    foreach ($name in $missing) {
        $t = $tools[$name]
        $command = "    winget install --id $($t.winget) -e"
        if ($t.override) { $command += ' --override "' + $t.override + '"' }
        Write-Host $command
    }
    Write-Host 'Or let setup install them: npm run setup -- -Install'
    exit 1
}

if ($Check) { Write-Host 'All tools found.' -ForegroundColor Green; exit 0 }

$steps = @(
    @{ name = 'JavaScript packages'; run = { npm install } },
    @{ name = 'vcpkg'; run = { npm run native:setup } },
    @{ name = 'ONNX Runtime with DirectML'; run = { npm run native:onnxruntime:gpu } },
    @{ name = 'Configure the native runtime (the first time builds OpenCV, which takes a while)'; run = { npm run native:configure } },
    @{ name = 'Build the native runtime'; run = { npm run native:build } }
)
if (-not $SkipPython) { $steps += @{ name = 'Python .venv'; run = { npm run python:setup } } }
foreach ($step in $steps) {
    Write-Host ''
    Write-Host "==> $($step.name)" -ForegroundColor Cyan
    & $step.run
    if ($LASTEXITCODE) { Write-Host "Setup stopped: '$($step.name)' failed (exit $LASTEXITCODE). See Troubleshooting in the README." -ForegroundColor Red; exit $LASTEXITCODE }
}
Write-Host ''
Write-Host 'FireFly is set up. Start it with: npm run build, then npm start' -ForegroundColor Green
