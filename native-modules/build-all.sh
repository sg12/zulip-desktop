#!/bin/bash

echo "🔨 Building native modules for Electron..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DIST_DIR="$SCRIPT_DIR/../dist-electron"

# Создаем директорию dist-electron если не существует
mkdir -p "$DIST_DIR"

# Определяем платформу
PLATFORM=$(uname -s)

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для сборки macOS модуля
build_mac() {
    echo -e "${GREEN}🍎 Building macOS module...${NC}"
    cd "$SCRIPT_DIR/mac"
    
    if [ -f "build.sh" ]; then
        bash build.sh
        
        # Проверяем результат в разных местах
        if [ -f "addon.node" ]; then
            cp addon.node "$DIST_DIR/native-addon.node"
            echo -e "${GREEN}✅ macOS module built and copied${NC}"
            return 0
        elif [ -f "build/Release/addon.node" ]; then
            cp build/Release/addon.node "$DIST_DIR/native-addon.node"
            echo -e "${GREEN}✅ macOS module built and copied${NC}"
            return 0
        else
            echo -e "${RED}❌ Failed to build macOS module${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}⚠️ macOS build script not found${NC}"
        return 1
    fi
}

# Функция для сборки Windows модуля
build_win() {
    echo -e "${GREEN}🪟 Building Windows module...${NC}"
    cd "$SCRIPT_DIR/win"
    
    if [ -f "build.sh" ]; then
        bash build.sh
        
        if [ -f "build/screen_capture_win.node" ]; then
            cp build/screen_capture_win.node "$DIST_DIR/screen_capture_win.node"
            echo -e "${GREEN}✅ Windows module built and copied${NC}"
            return 0
        else
            echo -e "${RED}❌ Failed to build Windows module${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}⚠️ Windows build script not found${NC}"
        return 1
    fi
}

# Функция для показа статуса
show_status() {
    echo ""
    echo "📊 Build Summary:"
    echo "════════════════════════════════════"
    
    if [ -f "$DIST_DIR/native-addon.node" ]; then
        SIZE=$(ls -lh "$DIST_DIR/native-addon.node" | awk '{print $5}')
        echo -e "${GREEN}✅ macOS module:${NC} $SIZE"
        
        # Проверяем архитектуру
        if command -v file &> /dev/null; then
            ARCH=$(file "$DIST_DIR/native-addon.node" | grep -o "arm64\|x86_64" | head -1)
            echo "   Architecture: $ARCH"
        fi
    else
        echo -e "${RED}❌ macOS module:${NC} not found"
    fi
    
    if [ -f "$DIST_DIR/screen_capture_win.node" ]; then
        SIZE=$(ls -lh "$DIST_DIR/screen_capture_win.node" | awk '{print $5}')
        TYPE="Mock JavaScript"
        echo -e "${GREEN}✅ Windows module:${NC} $SIZE ($TYPE)"
    else
        echo -e "${RED}❌ Windows module:${NC} not found"
    fi
    
    echo "════════════════════════════════════"
}

# Парсим аргументы
TARGET="${1:-current}"

case "$TARGET" in
    mac)
        build_mac
        show_status
        ;;
    win)
        build_win
        show_status
        ;;
    all)
        echo "Building all platforms..."
        build_mac
        build_win
        show_status
        ;;
    current)
        if [ "$PLATFORM" == "Darwin" ]; then
            build_mac
            show_status
        else
            echo -e "${YELLOW}⚠️ Native Windows build not implemented yet${NC}"
        fi
        ;;
    clean)
        echo "🧹 Cleaning build artifacts..."
        rm -rf "$SCRIPT_DIR/mac/build" "$SCRIPT_DIR/mac/*.o" "$SCRIPT_DIR/mac/*.node"
        rm -rf "$SCRIPT_DIR/win/build"
        rm -f "$DIST_DIR/*.node"
        echo "✅ Cleaned"
        ;;
    *)
        echo "Usage: $0 [mac|win|all|current|clean]"
        exit 1
        ;;
esac

echo ""
echo "🎉 Done!"