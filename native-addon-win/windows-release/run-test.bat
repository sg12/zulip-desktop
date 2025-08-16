@echo off
echo ========================================
echo Windows Screen Capture Module Test
echo ========================================
echo.

REM Проверяем наличие Node.js
where node >nul 2>1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js not found!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js version:
node --version
echo.

REM Проверяем архитектуру
echo System architecture:
wmic os get osarchitecture
echo.

REM Проверяем наличие модуля
if not exist "screen_capture_win.node" (
    echo ERROR: screen_capture_win.node not found!
    echo Make sure you extracted all files.
    pause
    exit /b 1
)

echo Module file found.
echo File size:
for %%A in (screen_capture_win.node) do echo %%~zA bytes
echo.

REM Запускаем тест
echo Starting test...
echo ----------------------------------------
node test-detailed.js
echo ----------------------------------------
echo.

REM Показываем лог файлы
echo Log files created:
dir /b test-log-*.txt
echo.

echo Test completed. Check log files for details.
pause
