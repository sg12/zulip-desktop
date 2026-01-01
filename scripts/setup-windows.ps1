# Script for Windows setup
# Run: PowerShell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Windows Project Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check versions
Write-Host "Checking versions..." -ForegroundColor Yellow
$nodeVersion = node -v 2>$null
if ($nodeVersion) {
    Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Node.js is not installed!" -ForegroundColor Red
    Write-Host "  Download from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$npmVersion = npm -v 2>$null
if ($npmVersion) {
    Write-Host "[OK] npm: $npmVersion" -ForegroundColor Green
} else {
    Write-Host "[ERROR] npm not found!" -ForegroundColor Red
    exit 1
}

$pythonVersion = python --version 2>$null
if ($pythonVersion) {
    Write-Host "[OK] Python: $pythonVersion" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Python is not installed!" -ForegroundColor Red
    Write-Host "  Download from https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "  Important: Check 'Add Python to PATH' during installation" -ForegroundColor Yellow
}

Write-Host ""

# Check VB-Cable
Write-Host "Checking VB-Audio Virtual Cable..." -ForegroundColor Yellow
$vcCheck = wmic sounddev get name 2>$null | Select-String -Pattern "cable|vb-audio" -CaseSensitive:$false
if ($vcCheck) {
    Write-Host "[OK] VB-Cable found: $vcCheck" -ForegroundColor Green
} else {
    Write-Host "[WARNING] VB-Cable not found" -ForegroundColor Yellow
    Write-Host "  Download from https://vb-audio.com/Cable/" -ForegroundColor Yellow
    Write-Host "  After installation, restart your computer!" -ForegroundColor Yellow
}

Write-Host ""

# Install dependencies
Write-Host "Installing npm dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to install dependencies!" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Dependencies installed" -ForegroundColor Green
Write-Host ""

# Compile Windows native module
Write-Host "Compiling Windows native module..." -ForegroundColor Yellow
Push-Location native-addon\win

if (Test-Path "package.json") {
    npm install
    $installExitCode = $LASTEXITCODE
    if ($installExitCode -ne 0) {
        Write-Host "[WARNING] Error installing addon dependencies" -ForegroundColor Yellow
    }
    
    npm run build
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -eq 0) {
        if (Test-Path "build\Release\capture.node") {
            Write-Host "[OK] Native module compiled successfully" -ForegroundColor Green
            Write-Host "  File: build\Release\capture.node" -ForegroundColor Gray
        } else {
            Write-Host "[WARNING] Module compiled but file not found" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[ERROR] Failed to compile native module!" -ForegroundColor Red
        Write-Host "  Make sure you have installed:" -ForegroundColor Yellow
        Write-Host "  - Visual Studio Build Tools" -ForegroundColor Yellow
        Write-Host "  - Windows SDK" -ForegroundColor Yellow
        Write-Host "  Or run: npm install -g windows-build-tools" -ForegroundColor Yellow
    }
} else {
    Write-Host "[WARNING] native-addon\win folder not found" -ForegroundColor Yellow
}

Pop-Location
Write-Host ""

# Copy module to dist-electron (if needed)
Write-Host "Checking dist-electron..." -ForegroundColor Yellow
$captureNodePath = "native-addon\win\build\Release\capture.node"
if (Test-Path $captureNodePath) {
    if (-not (Test-Path "dist-electron")) {
        New-Item -ItemType Directory -Path "dist-electron" | Out-Null
    }
    
    Copy-Item $captureNodePath "dist-electron\native-addon.node" -Force
    Write-Host "[OK] Module copied to dist-electron\native-addon.node" -ForegroundColor Green
} else {
    Write-Host "[WARNING] capture.node not found, skipping copy" -ForegroundColor Yellow
}

Write-Host ""

# Check SoundVolumeView
Write-Host "Checking SoundVolumeView..." -ForegroundColor Yellow
$svvPaths = @(
    "tools\SoundVolumeView.exe",
    "$env:LOCALAPPDATA\SoundVolumeView\SoundVolumeView.exe",
    "$env:ProgramFiles\SoundVolumeView\SoundVolumeView.exe"
)

$svvFound = $false
foreach ($svvPath in $svvPaths) {
    if (Test-Path $svvPath) {
        Write-Host "[OK] SoundVolumeView found: $svvPath" -ForegroundColor Green
        $svvFound = $true
        break
    }
}

# Check in PATH
if (-not $svvFound) {
    $svvInPath = Get-Command SoundVolumeView.exe -ErrorAction SilentlyContinue
    if ($svvInPath) {
        Write-Host "[OK] SoundVolumeView found in PATH: $($svvInPath.Source)" -ForegroundColor Green
        $svvFound = $true
    }
}

if (-not $svvFound) {
    Write-Host "[WARNING] SoundVolumeView not found" -ForegroundColor Yellow
    Write-Host "  Download from https://www.nirsoft.net/utils/sound_volume_view.html" -ForegroundColor Yellow
    Write-Host "  Extract to tools\ or add to PATH" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Setup completed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. If VB-Cable not found - install and restart computer" -ForegroundColor White
Write-Host "2. If SoundVolumeView not found - download and put in tools\" -ForegroundColor White
Write-Host "3. Run: npm start" -ForegroundColor White
Write-Host ""
