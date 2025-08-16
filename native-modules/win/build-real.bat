@echo off
echo ═══════════════════════════════════════════
echo Building REAL Windows Audio Capture Module
echo ═══════════════════════════════════════════

:: Проверяем node-gyp
where node-gyp >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing node-gyp...
    npm install -g node-gyp
)

:: Устанавливаем зависимости
echo Installing dependencies...
npm install node-addon-api

:: Очищаем старую сборку
if exist build rmdir /s /q build

:: Собираем модуль
echo Building native module...
node-gyp configure
node-gyp build

:: Проверяем результат
if exist build\Release\audio_capture_win.node (
    echo ✅ Build successful!
    echo Module location: build\Release\audio_capture_win.node
    
    :: Копируем в нужное место
    copy build\Release\audio_capture_win.node ..\..\dist-electron\screen_capture_win.node
    echo ✅ Copied to dist-electron
) else (
    echo ❌ Build failed!
    exit /b 1
)

pause