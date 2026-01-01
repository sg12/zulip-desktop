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
    foreach ($err in $parseErrors) {
        Write-Host "  Line $($err.Extent.StartLineNumber): $($err.Message)" -ForegroundColor Red
    }
    exit 1
}

Write-Host "[OK] PowerShell syntax is correct" -ForegroundColor Green

# Check brace balance using regex
$content = Get-Content $scriptPath -Raw
$openBraceChar = [char]123  # ASCII for '{'
$closeBraceChar = [char]125 # ASCII for '}'
$openBraces = ($content.ToCharArray() | Where-Object { $_ -eq $openBraceChar }).Count
$closeBraces = ($content.ToCharArray() | Where-Object { $_ -eq $closeBraceChar }).Count

Write-Host "Checking brace balance..." -ForegroundColor Yellow
Write-Host "  Open braces: $openBraces" -ForegroundColor Gray
Write-Host "  Close braces: $closeBraces" -ForegroundColor Gray

if ($openBraces -ne $closeBraces) {
    Write-Host "[ERROR] Unbalanced braces! Open: $openBraces, Close: $closeBraces" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Brace balance is correct" -ForegroundColor Green

# Check parentheses balance
$openParen = [char]40  # ASCII for '('
$closeParen = [char]41 # ASCII for ')'
$openParens = ($content.ToCharArray() | Where-Object { $_ -eq $openParen }).Count
$closeParens = ($content.ToCharArray() | Where-Object { $_ -eq $closeParen }).Count

if ($openParens -ne $closeParens) {
    Write-Host "[ERROR] Unbalanced parentheses! Open: $openParens, Close: $closeParens" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Parentheses balance is correct" -ForegroundColor Green

# Check if script can be loaded as scriptblock
$scriptContent = Get-Content $scriptPath -Raw
try {
    $scriptBlock = [scriptblock]::Create($scriptContent)
    Write-Host "[OK] Script can be loaded as scriptblock" -ForegroundColor Green
}
catch {
    Write-Host "[ERROR] Error creating scriptblock: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All checks passed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

exit 0
