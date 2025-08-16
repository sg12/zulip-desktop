#!/bin/bash

echo "🪟 Cross-compiling Windows module with Zig..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Проверяем наличие Zig
if ! command -v zig &> /dev/null; then
    echo "❌ Zig not found. Install with: brew install zig"
    exit 1
fi

cd "$SCRIPT_DIR"

# Создаем директорию build
mkdir -p build

echo "📦 Compiling C++ to Windows DLL..."

# Компилируем для Windows x64
zig c++ \
    -target x86_64-windows-gnu \
    -shared \
    -O2 \
    -fno-sanitize=undefined \
    -Isrc \
    -DBUILDING_NODE_EXTENSION \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    src/main.cpp \
    -o build/screen_capture_win.node \
    -lc++ \
    2>&1 | tee build/compile.log

if [ $? -eq 0 ]; then
    echo "✅ Compilation successful!"
    echo "📊 Module size: $(ls -lh build/screen_capture_win.node | awk '{print $5}')"
    
    # Проверяем, что это действительно Windows PE файл
    if command -v file &> /dev/null; then
        echo "📋 File type: $(file build/screen_capture_win.node)"
    fi
else
    echo "❌ Compilation failed. Check build/compile.log for details"
    exit 1
fi