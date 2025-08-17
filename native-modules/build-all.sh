#!/bin/bash

echo "🔨 Building native modules for Electron..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DIST_DIR="$SCRIPT_DIR/../dist-electron"

# Создаем директорию dist-electron если не существует
mkdir -p "$DIST_DIR"

# Определяем платформу и архитектуру
PLATFORM=$(uname -s)
ARCH=$(uname -m)

# Определяем версию Electron из package.json (ищем в родительской директории)
PARENT_DIR="$SCRIPT_DIR/.."
if [ -f "$PARENT_DIR/package.json" ]; then
    ELECTRON_VERSION=$(node -p "require('$PARENT_DIR/package.json').devDependencies?.electron || require('$PARENT_DIR/package.json').dependencies?.electron || ''" 2>/dev/null | sed 's/[\^~]//')
fi

if [ -z "$ELECTRON_VERSION" ]; then
    ELECTRON_VERSION="32.3.3"
    echo "⚠️  Electron version not found in package.json, using default: $ELECTRON_VERSION"
else
    echo "📦 Target Electron version: $ELECTRON_VERSION"
fi

# Экспортируем для дочерних скриптов
export ELECTRON_VERSION

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функция для сборки macOS модуля
build_mac() {
    echo -e "${GREEN}🍎 Building macOS module for Electron $ELECTRON_VERSION...${NC}"
    cd "$SCRIPT_DIR/mac"
    
    # Проверяем наличие скриптов в порядке приоритета
    if [ -f "build-universal.sh" ]; then
        echo -e "${BLUE}🔄 Building Universal Binary (x86_64 + ARM64)...${NC}"
        bash build-universal.sh
        BUILD_RESULT=$?
        
    elif [ -f "build-for-electron-direct.sh" ]; then
        echo -e "${BLUE}📱 Building for current architecture ($ARCH) with Electron support...${NC}"
        bash build-for-electron-direct.sh
        BUILD_RESULT=$?
        
    elif [ -f "build.sh" ]; then
        echo -e "${YELLOW}⚠️  Using legacy build script...${NC}"
        bash build.sh
        BUILD_RESULT=$?
    else
        echo -e "${RED}❌ No build script found${NC}"
        echo "Available files in mac directory:"
        ls -la
        return 1
    fi
    
    # Проверяем результат сборки
    if [ $BUILD_RESULT -eq 0 ]; then
        if [ -f "addon.node" ]; then
            # Копируем модуль
            cp addon.node "$DIST_DIR/native-addon.node"
            
            # Проверяем архитектуры
            if command -v lipo &> /dev/null; then
                ARCHS=$(lipo -archs addon.node 2>/dev/null)
                if [[ "$ARCHS" == *"x86_64"* ]] && [[ "$ARCHS" == *"arm64"* ]]; then
                    echo -e "${GREEN}✅ Universal binary created (x86_64 + arm64)${NC}"
                elif [[ "$ARCHS" == *"arm64"* ]]; then
                    echo -e "${GREEN}✅ ARM64 module built${NC}"
                elif [[ "$ARCHS" == *"x86_64"* ]]; then
                    echo -e "${GREEN}✅ x86_64 module built${NC}"
                fi
            fi
            
            # Быстрая проверка модуля
            echo -e "${BLUE}🧪 Quick module test...${NC}"
            node -e "try { require('$PWD/addon.node'); console.log('✅ Module syntax is valid'); } catch(e) { console.log('⚠️ Module may need Electron context:', e.message.split('\\n')[0]); }"
            
            return 0
        elif [ -f "build/Release/addon.node" ]; then
            cp build/Release/addon.node "$DIST_DIR/native-addon.node"
            echo -e "${GREEN}✅ macOS module built and copied${NC}"
            return 0
        else
            echo -e "${RED}❌ addon.node not found after build${NC}"
            echo "Files in current directory:"
            ls -la *.node 2>/dev/null || echo "No .node files found"
            return 1
        fi
    else
        echo -e "${RED}❌ Build failed with exit code $BUILD_RESULT${NC}"
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
    echo -e "${BLUE}Platform:${NC} $PLATFORM ($ARCH)"
    echo -e "${BLUE}Electron:${NC} $ELECTRON_VERSION"
    echo ""
    
    if [ -f "$DIST_DIR/native-addon.node" ]; then
        SIZE=$(ls -lh "$DIST_DIR/native-addon.node" | awk '{print $5}')
        echo -e "${GREEN}✅ macOS module:${NC} $SIZE"
        
        # Детальная информация о файле
        if command -v file &> /dev/null; then
            FILE_INFO=$(file "$DIST_DIR/native-addon.node" | cut -d: -f2 | xargs)
            echo "   Type: $FILE_INFO"
        fi
        
        # Проверяем поддерживаемые архитектуры
        if command -v lipo &> /dev/null; then
            ARCHS=$(lipo -archs "$DIST_DIR/native-addon.node" 2>/dev/null)
            if [ ! -z "$ARCHS" ]; then
                echo "   Architectures: $ARCHS"
                
                # Проверяем, соответствует ли текущей архитектуре
                if [[ "$ARCH" == "arm64" ]] && [[ "$ARCHS" == *"arm64"* ]]; then
                    echo -e "   ${GREEN}✓ Compatible with current system (ARM64)${NC}"
                elif [[ "$ARCH" == "x86_64" ]] && [[ "$ARCHS" == *"x86_64"* ]]; then
                    echo -e "   ${GREEN}✓ Compatible with current system (x86_64)${NC}"
                elif [[ "$ARCHS" == *"x86_64"* ]] && [[ "$ARCHS" == *"arm64"* ]]; then
                    echo -e "   ${GREEN}✓ Universal binary (works on all Macs)${NC}"
                else
                    echo -e "   ${YELLOW}⚠️ May not be compatible with current system${NC}"
                fi
            fi
        fi
    else
        echo -e "${RED}❌ macOS module:${NC} not found"
    fi
    
    if [ -f "$DIST_DIR/screen_capture_win.node" ]; then
        SIZE=$(ls -lh "$DIST_DIR/screen_capture_win.node" | awk '{print $5}')
        echo -e "${GREEN}✅ Windows module:${NC} $SIZE"
    else
        echo -e "${YELLOW}⚠️ Windows module:${NC} not built"
    fi
    
    echo "════════════════════════════════════"
}

# Новая функция для тестирования с Electron
test_module() {
    echo -e "${BLUE}🧪 Testing native module with Electron...${NC}"
    
    if [ ! -f "$DIST_DIR/native-addon.node" ]; then
        echo -e "${RED}❌ Module not found. Run build first.${NC}"
        return 1
    fi
    
    # Проверяем наличие Electron
    if ! command -v npx &> /dev/null || ! npx electron --version &> /dev/null 2>&1; then
        echo -e "${YELLOW}📦 Installing Electron...${NC}"
        cd "$PARENT_DIR"
        npm install electron@$ELECTRON_VERSION --save-dev
    fi
    
    cd "$PARENT_DIR"
    
    # Создаем тестовый скрипт
    cat > test-native-module.js << 'EOF'
try {
    const path = require('path');
    const modulePath = path.join(__dirname, 'dist-electron', 'native-addon.node');
    const addon = require(modulePath);
    
    console.log('✅ Module loaded successfully in Electron!');
    console.log('\nAvailable methods:');
    const methods = Object.keys(addon).filter(k => typeof addon[k] === 'function');
    methods.forEach(m => console.log(`  • ${m}`));
    
    // Test basic functionality
    if (typeof addon.getFrameStats === 'function') {
        const stats = addon.getFrameStats();
        console.log('\nFrame stats:', stats);
    }
    
    process.exit(0);
} catch(e) {
    console.error('❌ Failed to load module:', e.message);
    process.exit(1);
}
EOF
    
    # Запускаем тест
    npx electron test-native-module.js
    TEST_RESULT=$?
    
    # Удаляем временный файл
    rm -f test-native-module.js
    
    return $TEST_RESULT
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
    test)
        test_module
        ;;
    clean)
        echo "🧹 Cleaning build artifacts..."
        rm -rf "$SCRIPT_DIR/mac/build" 
        rm -f "$SCRIPT_DIR/mac"/*.o 
        rm -f "$SCRIPT_DIR/mac"/*.node
        rm -f "$SCRIPT_DIR/mac/CaptureModule-Swift.h"
        rm -f "$SCRIPT_DIR/mac/swift_integrated_capture.mm"
        rm -rf "$SCRIPT_DIR/win/build"
        rm -f "$DIST_DIR"/*.node
        echo "✅ Cleaned"
        ;;
    *)
        echo "Usage: $0 [mac|win|all|current|test|clean]"
        echo ""
        echo "Commands:"
        echo "  mac      - Build macOS module"
        echo "  win      - Build Windows module"  
        echo "  all      - Build all platforms"
        echo "  current  - Build for current platform (default)"
        echo "  test     - Test the module with Electron"
        echo "  clean    - Clean all build artifacts"
        exit 1
        ;;
esac

echo ""

# Подсказка после успешной сборки
if [ "$TARGET" != "test" ] && [ "$TARGET" != "clean" ] && [ -f "$DIST_DIR/native-addon.node" ]; then
    echo "💡 To test the module with Electron, run:"
    echo "   $0 test"
fi

echo "🎉 Done!"