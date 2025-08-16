#!/bin/bash

echo "🍎 Building macOS native module..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Определяем версию Electron из корневого package.json
ELECTRON_VERSION=$(node -p "require('../../package.json').devDependencies.electron.replace(/[^0-9.]/g, '')" 2>/dev/null)

if [ -z "$ELECTRON_VERSION" ]; then
    echo "⚠️ Could not detect Electron version, using 32.3.3"
    ELECTRON_VERSION="32.3.3"
fi

echo "📦 Target Electron: v${ELECTRON_VERSION}"

# Проверяем наличие исходников
if [ ! -f "ScreenCaptureManager.swift" ]; then
    echo "❌ ScreenCaptureManager.swift not found!"
    echo "Please ensure all source files are in native-modules/mac/"
    exit 1
fi

# Используем ваш проверенный скрипт сборки
if [ -f "build-for-electron-direct.sh" ]; then
    echo "🔨 Using direct build method..."
    bash build-for-electron-direct.sh
    
    if [ -f "addon.node" ]; then
        echo "✅ macOS module built successfully"
        echo "📊 Module size: $(ls -lh addon.node | awk '{print $5}')"
        
        # Создаем директорию build/Release для совместимости
        mkdir -p build/Release
        cp addon.node build/Release/
        
        exit 0
    else
        echo "❌ Build failed"
        exit 1
    fi
else
    echo "❌ build-for-electron-direct.sh not found"
    exit 1
fi