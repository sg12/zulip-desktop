# Тест синтаксиса PowerShell скрипта setup-windows.ps1
# Запуск: PowerShell -ExecutionPolicy Bypass -File scripts\__tests__\setup-windows.test.ps1

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Тест синтаксиса setup-windows.ps1" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$scriptPath = Join-Path $PSScriptRoot "..\setup-windows.ps1"

# Проверка существования файла
if (-not (Test-Path $scriptPath)) {
    Write-Host "[ERROR] Файл не найден: $scriptPath" -ForegroundColor Red
    exit 1
}

Write-Host "Проверка файла: $scriptPath" -ForegroundColor Yellow

# Проверка синтаксиса PowerShell через парсер
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$null,
    [ref]$parseErrors
)

if ($parseErrors -and $parseErrors.Count -gt 0) {
    Write-Host "[ERROR] Обнаружены ошибки синтаксиса:" -ForegroundColor Red
    foreach ($error in $parseErrors) {
        Write-Host "  Строка $($error.Extent.StartLineNumber): $($error.Message)" -ForegroundColor Red
        Write-Host "    $($error.Extent.Text)" -ForegroundColor Gray
    }
    exit 1
}

Write-Host "[OK] Синтаксис PowerShell корректен" -ForegroundColor Green

# Проверка баланса скобок
$content = Get-Content $scriptPath -Raw
$openBraces = ([regex]::Matches($content, '\{')).Count
$closeBraces = ([regex]::Matches($content, '\}')).Count

Write-Host "Проверка баланса скобок..." -ForegroundColor Yellow
Write-Host "  Открывающих '{': $openBraces" -ForegroundColor Gray
Write-Host "  Закрывающих '}': $closeBraces" -ForegroundColor Gray

if ($openBraces -ne $closeBraces) {
    Write-Host "[ERROR] Несбалансированные скобки!" -ForegroundColor Red
    Write-Host "  Открывающих: $openBraces, Закрывающих: $closeBraces" -ForegroundColor Red
    
    # Показываем строки с открывающими скобками
    $lines = Get-Content $scriptPath
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '\{') {
            Write-Host "  Строка $($i+1): $($lines[$i].Trim())" -ForegroundColor Yellow
        }
    }
    exit 1
}

Write-Host "[OK] Баланс скобок корректен" -ForegroundColor Green

# Проверка баланса круглых скобок
$openParens = ([regex]::Matches($content, '\(')).Count
$closeParens = ([regex]::Matches($content, '\)')).Count

if ($openParens -ne $closeParens) {
    Write-Host "[ERROR] Несбалансированные круглые скобки!" -ForegroundColor Red
    Write-Host "  Открывающих: $openParens, Закрывающих: $closeParens" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Баланс круглых скобок корректен" -ForegroundColor Green

# Проверка что скрипт можно загрузить как модуль (без выполнения)
$scriptContent = Get-Content $scriptPath -Raw
try {
    $scriptBlock = [scriptblock]::Create($scriptContent)
    if ($scriptBlock) {
        Write-Host "[OK] Скрипт может быть загружен как scriptblock" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Ошибка при создании scriptblock" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] Ошибка при создании scriptblock: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Все проверки пройдены успешно!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

exit 0
