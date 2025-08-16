# PowerShell diagnostic script
Write-Host "=== Windows Screen Capture Module Diagnostics ===" -ForegroundColor Cyan
Write-Host ""

# System info
Write-Host "SYSTEM INFORMATION:" -ForegroundColor Yellow
Write-Host "OS Version: " -NoNewline
[System.Environment]::OSVersion.Version
Write-Host "Architecture: $env:PROCESSOR_ARCHITECTURE"
Write-Host "Node.js: " -NoNewline
node --version
Write-Host ""

# Check module file
Write-Host "MODULE CHECK:" -ForegroundColor Yellow
$modulePath = ".\screen_capture_win.node"

if (Test-Path $modulePath) {
    Write-Host "✓ Module file exists" -ForegroundColor Green
    $file = Get-Item $modulePath
    Write-Host "  Size: $($file.Length) bytes"
    Write-Host "  Created: $($file.CreationTime)"
    
    # Check dependencies using dumpbin if available
    $dumpbin = "C:\Program Files\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe"
    $dumpbinPath = Get-ChildItem -Path $dumpbin -ErrorAction SilentlyContinue | Select-Object -First 1
    
    if ($dumpbinPath) {
        Write-Host ""
        Write-Host "MODULE DEPENDENCIES:" -ForegroundColor Yellow
        & $dumpbinPath.FullName /DEPENDENTS $modulePath | Select-String "\.dll"
    }
} else {
    Write-Host "✗ Module file NOT found!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "TESTING MODULE LOAD:" -ForegroundColor Yellow

# Create test script
$testScript = @'
try {
    const m = require('./screen_capture_win.node');
    console.log('SUCCESS: Module loaded');
    console.log('Exports:', Object.keys(m));
    process.exit(0);
} catch (error) {
    console.error('FAILED:', error.message);
    if (error.stack) {
        console.error('Stack:', error.stack);
    }
    process.exit(1);
}
'@

$testScript | Out-File -FilePath "quick-test.js" -Encoding UTF8

# Run test
$result = node quick-test.js 2>&1
Write-Host $result

# Cleanup
Remove-Item quick-test.js -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Diagnostics Complete ===" -ForegroundColor Cyan
Write-Host "Run .\run-test.bat for full functionality test" -ForegroundColor Green
