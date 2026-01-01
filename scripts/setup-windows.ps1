# Скрипт автоматической настройки для Windows
# Запуск: PowerShell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Настройка проекта для Windows" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Проверка версий
Write-Host "Проверка версий..." -ForegroundColor Yellow
try {
    $nodeVersion = node -v 2>$null
    if ($nodeVersion) {
        Write-Host "✓ Node.js: $nodeVersion" -ForegroundColor Green
    } else {
        Write-Host "✗ Node.js не установлен!" -ForegroundColor Red
        Write-Host "  Скачайте с https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }
} catch {
    Write-Host "✗ Node.js не установлен!" -ForegroundColor Red
    exit 1
}

try {
    $npmVersion = npm -v 2>$null
    if ($npmVersion) {
        Write-Host "✓ npm: $npmVersion" -ForegroundColor Green
    } else {
        Write-Host "✗ npm не найден!" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ npm не найден!" -ForegroundColor Red
    exit 1
}

try {
    $pythonVersion = python --version 2>$null
    if ($pythonVersion) {
        Write-Host "✓ Python: $pythonVersion" -ForegroundColor Green
    } else {
        Write-Host "✗ Python не установлен!" -ForegroundColor Red
        Write-Host "  Скачайте с https://www.python.org/downloads/" -ForegroundColor Yellow
        Write-Host "  ⚠️  Важно: Отметьте 'Add Python to PATH' при установке" -ForegroundColor Yellow
    }
} catch {
    Write-Host "✗ Python не установлен!" -ForegroundColor Red
    Write-Host "  Скачайте с https://www.python.org/downloads/" -ForegroundColor Yellow
}

Write-Host ""

# Проверка VB-Cable
Write-Host "Проверка VB-Audio Virtual Cable..." -ForegroundColor Yellow
try {
    $vcCheck = wmic sounddev get name 2>$null | Select-String -Pattern "cable|vb-audio" -CaseSensitive:$false
    if ($vcCheck) {
        Write-Host "✓ VB-Cable найден: $vcCheck" -ForegroundColor Green
    } else {
        Write-Host "⚠️  VB-Cable не найден" -ForegroundColor Yellow
        Write-Host "  Скачайте с https://vb-audio.com/Cable/" -ForegroundColor Yellow
        Write-Host "  После установки перезагрузите компьютер!" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  Не удалось проверить VB-Cable" -ForegroundColor Yellow
}

Write-Host ""

# Установка зависимостей
Write-Host "Установка npm зависимостей..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Ошибка при установке зависимостей!" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Зависимости установлены" -ForegroundColor Green
Write-Host ""

# Компиляция Windows нативного модуля
Write-Host "Компиляция Windows нативного модуля..." -ForegroundColor Yellow
Push-Location native-addon\win

if (Test-Path "package.json") {
    npm install
    $installExitCode = $LASTEXITCODE
    if ($installExitCode -ne 0) {
        Write-Host "⚠️  Предупреждение: Ошибка при установке зависимостей addon" -ForegroundColor Yellow
    }
    
    npm run build
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -eq 0) {
        if (Test-Path "build\Release\capture.node") {
            Write-Host "✓ Нативный модуль скомпилирован успешно" -ForegroundColor Green
            Write-Host "  Файл: build\Release\capture.node" -ForegroundColor Gray
        } else {
            Write-Host "⚠️  Модуль скомпилирован, но файл не найден" -ForegroundColor Yellow
        }
    } else {
        Write-Host "✗ Ошибка компиляции нативного модуля!" -ForegroundColor Red
        Write-Host "  Убедитесь что установлены:" -ForegroundColor Yellow
        Write-Host "  - Visual Studio Build Tools" -ForegroundColor Yellow
        Write-Host "  - Windows SDK" -ForegroundColor Yellow
        Write-Host "  Или выполните: npm install -g windows-build-tools" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️  Папка native-addon\win не найдена" -ForegroundColor Yellow
}

Pop-Location
Write-Host ""

# Копирование модуля в dist-electron (если нужно)
Write-Host "Проверка dist-electron..." -ForegroundColor Yellow
$captureNodePath = "native-addon\win\build\Release\capture.node"
if (Test-Path $captureNodePath) {
    if (-not (Test-Path "dist-electron")) {
        New-Item -ItemType Directory -Path "dist-electron" | Out-Null
    }
    
    Copy-Item $captureNodePath "dist-electron\native-addon.node" -Force
    Write-Host "✓ Модуль скопирован в dist-electron\native-addon.node" -ForegroundColor Green
} else {
    Write-Host "⚠️  capture.node не найден, пропускаем копирование" -ForegroundColor Yellow
}

Write-Host ""

# Проверка SoundVolumeView
Write-Host "Проверка SoundVolumeView..." -ForegroundColor Yellow
$svvPaths = @(
    "tools\SoundVolumeView.exe",
    "$env:LOCALAPPDATA\SoundVolumeView\SoundVolumeView.exe",
    "$env:ProgramFiles\SoundVolumeView\SoundVolumeView.exe"
)

$svvFound = $false
foreach ($svvPath in $svvPaths) {
    if (Test-Path $svvPath) {
        Write-Host "✓ SoundVolumeView найден: $svvPath" -ForegroundColor Green
        $svvFound = $true
        break
    }
}

# Проверка в PATH
if (-not $svvFound) {
    try {
        $svvInPath = Get-Command SoundVolumeView.exe -ErrorAction SilentlyContinue
        if ($svvInPath) {
            Write-Host "✓ SoundVolumeView найден в PATH: $($svvInPath.Source)" -ForegroundColor Green
            $svvFound = $true
        }
    } catch {
        # Игнорируем ошибку
    }
}

if (-not $svvFound) {
    Write-Host "⚠️  SoundVolumeView не найден" -ForegroundColor Yellow
    Write-Host "  Скачайте с https://www.nirsoft.net/utils/sound_volume_view.html" -ForegroundColor Yellow
    Write-Host "  Распакуйте в tools\ или добавьте в PATH" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Настройка завершена!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Следующие шаги:" -ForegroundColor Yellow
Write-Host "1. Если VB-Cable не найден - установите и перезагрузите компьютер" -ForegroundColor White
Write-Host "2. Если SoundVolumeView не найден - скачайте и положите в tools\" -ForegroundColor White
Write-Host "3. Запустите: npm start" -ForegroundColor White
Write-Host ""
