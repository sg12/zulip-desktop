#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🪟 Building Windows module..."

# Для сейчас используем JavaScript mock, который будет работать везде
# Позже можно заменить на настоящий C++ модуль

# Проверяем, какой метод использовать
USE_MOCK=true

if [ "$USE_MOCK" = true ]; then
    echo "📝 Creating JavaScript mock module for Windows..."
    node "$SCRIPT_DIR/create-mock.js"
else
    # Будущая поддержка Zig компиляции
    if command -v zig &> /dev/null; then
        echo "🔧 Using Zig for cross-compilation..."
        bash "$SCRIPT_DIR/build-zig.sh"
    else
        echo "⚠️ Zig not found, creating JavaScript mock..."
        node "$SCRIPT_DIR/create-mock.js"
    fi
fi
