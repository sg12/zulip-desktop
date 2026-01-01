# Test syntax of PowerShell script setup-windows.ps1
# Run: PowerShell -ExecutionPolicy Bypass -File scripts\__tests__\setup-windows.test.ps1

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Syntax Test for setup-windows.ps1" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$scriptPath = Join-Path $PSScriptRoot "..\setup-windows.ps1"

# Check if file exists
if (-not (Test-Path $scriptPath)) {
    Write-Host "[ERROR] File not found: $scriptPath" -ForegroundColor Red
    exit 1
}

Write-Host "Checking file: $scriptPath" -ForegroundColor Yellow

# Check PowerShell syntax via parser
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$null,
    [ref]$parseErrors
)

if ($parseErrors -and $parseErrors.Count -gt 0) {
    Write-Host "[ERROR] Syntax errors found:" -ForegroundColor Red
    foreach ($error in $parseErrors) {
        Write-Host "  Line $($error.Extent.StartLineNumber): $($error.Message)" -ForegroundColor Red
        Write-Host "    $($error.Extent.Text)" -ForegroundColor Gray
    }
    exit 1
}

Write-Host "[OK] PowerShell syntax is correct" -ForegroundColor Green

# Check brace balance
$content = Get-Content $scriptPath -Raw
$openBraces = ($content.ToCharArray() | Where-Object { $_ -eq '{' }).Count
$closeBraces = ($content.ToCharArray() | Where-Object { $_ -eq '}' }).Count

Write-Host "Checking brace balance..." -ForegroundColor Yellow
Write-Host "  Open braces: $openBraces" -ForegroundColor Gray
Write-Host "  Close braces: $closeBraces" -ForegroundColor Gray

if ($openBraces -ne $closeBraces) {
    Write-Host "[ERROR] Unbalanced braces!" -ForegroundColor Red
    Write-Host "  Open: $openBraces, Close: $closeBraces" -ForegroundColor Red
    
    # Show lines with opening braces
    $lines = Get-Content $scriptPath
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '\{') {
            Write-Host "  Line $($i+1): $($lines[$i].Trim())" -ForegroundColor Yellow
        }
    }
    exit 1
}

Write-Host "[OK] Brace balance is correct" -ForegroundColor Green

# Check parentheses balance
$openParens = ($content.ToCharArray() | Where-Object { $_ -eq '(' }).Count
$closeParens = ($content.ToCharArray() | Where-Object { $_ -eq ')' }).Count

if ($openParens -ne $closeParens) {
    Write-Host "[ERROR] Unbalanced parentheses!" -ForegroundColor Red
    Write-Host "  Open: $openParens, Close: $closeParens" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Parentheses balance is correct" -ForegroundColor Green

# Check if script can be loaded as module (without execution)
$scriptContent = Get-Content $scriptPath -Raw
try {
    $scriptBlock = [scriptblock]::Create($scriptContent)
    if ($scriptBlock) {
        Write-Host "[OK] Script can be loaded as scriptblock" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Failed to create scriptblock" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] Error creating scriptblock: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All checks passed successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

exit 0
