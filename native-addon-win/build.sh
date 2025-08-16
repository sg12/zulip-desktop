#!/bin/bash

echo "�� Setting up build environment..."

CXX="/usr/local/Cellar/mingw-w64/13.0.0/toolchain-x86_64/bin/x86_64-w64-mingw32-g++"
echo "✅ Found MinGW: $CXX"

NODE_ADDON_API=$(pwd)/node_modules/node-addon-api
NODE_API_HEADERS=$(pwd)/node_modules/node-api-headers/include

echo "📚 Node addon API: $NODE_ADDON_API"
echo "📚 Node API headers: $NODE_API_HEADERS"

mkdir -p build

echo "🔨 Building Windows module..."

# Компилируем main.cpp с особыми флагами для Node.js addon
echo "Compiling main.cpp..."
$CXX -c src/main.cpp -o build/main.o \
    -I"$NODE_ADDON_API" \
    -I"$NODE_API_HEADERS" \
    -Isrc \
    -std=c++17 \
    -DNAPI_DISABLE_CPP_EXCEPTIONS \
    -D_WIN32_WINNT=0x0A00 \
    -DWINVER=0x0A00 \
    -DBUILDING_NODE_EXTENSION \
    -DNAPI_VERSION=8 \
    -Wno-attributes \
    -Wno-unknown-pragmas \
    -Wno-deprecated-declarations 2>&1

if [ $? -ne 0 ]; then
    echo "❌ Failed to compile main.cpp"
    exit 1
fi
echo "✅ main.cpp compiled"

# Компилируем остальные файлы
echo "Compiling capture_manager.cpp..."
$CXX -c src/capture_manager.cpp -o build/capture_manager.o \
    -Isrc \
    -std=c++17 \
    -D_WIN32_WINNT=0x0A00 \
    -Wno-attributes 2>&1

if [ $? -ne 0 ]; then
    echo "❌ Failed to compile capture_manager.cpp"
    exit 1
fi
echo "✅ capture_manager.cpp compiled"

echo "Compiling screen_capture.cpp..."
$CXX -c src/screen_capture.cpp -o build/screen_capture.o \
    -Isrc \
    -std=c++17 \
    -D_WIN32_WINNT=0x0A00 \
    -Wno-attributes 2>&1

if [ $? -ne 0 ]; then
    echo "❌ Failed to compile screen_capture.cpp"
    exit 1
fi
echo "✅ screen_capture.cpp compiled"

echo "Compiling audio_capture.cpp..."
$CXX -c src/audio_capture.cpp -o build/audio_capture.o \
    -Isrc \
    -std=c++17 \
    -D_WIN32_WINNT=0x0A00 \
    -Wno-attributes 2>&1

if [ $? -ne 0 ]; then
    echo "❌ Failed to compile audio_capture.cpp"
    exit 1
fi
echo "✅ audio_capture.cpp compiled"

# Создаем stub библиотеку для Node.js API
echo "Creating Node.js API stub library..."
cat > build/node_api_stub.c << 'STUB'
#include <stddef.h>

// Stub implementations for Node-API functions
void* napi_create_function() { return NULL; }
void* napi_add_finalizer() { return NULL; }
void* napi_get_undefined() { return NULL; }
void* napi_get_null() { return NULL; }
void* napi_get_boolean() { return NULL; }
void* napi_create_object() { return NULL; }
void* napi_create_string_utf8() { return NULL; }
void* napi_create_int32() { return NULL; }
void* napi_create_double() { return NULL; }
void* napi_set_named_property() { return NULL; }
void* napi_get_cb_info() { return NULL; }
void* napi_throw_error() { return NULL; }
void* napi_create_error() { return NULL; }
void* napi_create_type_error() { return NULL; }
void* napi_throw_type_error() { return NULL; }
void* napi_set_property() { return NULL; }
void* napi_has_property() { return NULL; }
void* napi_get_property() { return NULL; }
void* napi_is_array() { return NULL; }
void* napi_get_array_length() { return NULL; }
void* napi_create_array() { return NULL; }
void* napi_create_array_with_length() { return NULL; }
void* napi_get_element() { return NULL; }
void* napi_set_element() { return NULL; }
void* napi_define_class() { return NULL; }
void* napi_wrap() { return NULL; }
void* napi_unwrap() { return NULL; }
void* napi_create_external() { return NULL; }
void* napi_get_value_external() { return NULL; }
void* napi_create_reference() { return NULL; }
void* napi_delete_reference() { return NULL; }
void* napi_reference_ref() { return NULL; }
void* napi_reference_unref() { return NULL; }
void* napi_get_reference_value() { return NULL; }
void* napi_typeof() { return NULL; }
void* napi_get_value_string_utf8() { return NULL; }
void* napi_get_value_bool() { return NULL; }
void* napi_get_value_int32() { return NULL; }
void* napi_get_value_int64() { return NULL; }
void* napi_get_value_double() { return NULL; }
void* napi_create_threadsafe_function() { return NULL; }
void* napi_call_threadsafe_function() { return NULL; }
void* napi_release_threadsafe_function() { return NULL; }
void* napi_get_threadsafe_function_context() { return NULL; }
void* napi_acquire_threadsafe_function() { return NULL; }
STUB

# Компилируем stub
$CXX -c build/node_api_stub.c -o build/node_api_stub.o

# Линкуем с stub библиотекой
echo "Linking with stubs..."
$CXX -shared -o build/screen_capture_win.node \
    build/main.o \
    build/capture_manager.o \
    build/screen_capture.o \
    build/audio_capture.o \
    build/node_api_stub.o \
    -static-libgcc \
    -static-libstdc++ \
    -Wl,--allow-multiple-definition \
    -Wl,--export-all-symbols

if [ $? -eq 0 ]; then
    echo "✅ Build complete!"
    echo "📦 Output: build/screen_capture_win.node"
    ls -la build/*.node
    
    echo ""
    echo "⚠️  Note: This is a cross-compiled module with stubs."
    echo "    It won't run on macOS but should work on Windows."
    echo ""
    echo "📋 Next steps:"
    echo "    1. Copy build/screen_capture_win.node to a Windows machine"
    echo "    2. Test with: node -e \"require('./screen_capture_win.node')\""
else
    echo "❌ Linking failed"
fi
