#!/bin/bash

echo "🚀 Building for Node.js (not Electron)..."

# Проверяем версию Node.js
NODE_VERSION=$(node --version)
echo "📦 Node.js version: $NODE_VERSION"

MACOS_VERSION=$(sw_vers -productVersion | cut -d '.' -f 1,2)
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    TARGET_ARCH="arm64"
else
    TARGET_ARCH="x86_64"
fi

echo "🎯 Target: ${TARGET_ARCH}-apple-macos${MACOS_VERSION}"

# Clean
echo "🧹 Cleaning previous builds..."
rm -f *.o addon.node CaptureModule-Swift.h

# Install node-gyp if needed
if ! npm list -g node-gyp > /dev/null 2>&1; then
    echo "📦 Installing node-gyp..."
    npm install -g node-gyp
fi

# Ensure we have the right headers
echo "📥 Ensuring Node.js headers are available..."
node-gyp install

# Find the headers path
NODE_GYP_DIR="$HOME/.node-gyp/$(node --version | sed 's/v//')"
if [ -d "$NODE_GYP_DIR/include/node" ]; then
    NODE_HEADERS="$NODE_GYP_DIR/include/node"
else
    echo "❌ Could not find Node.js headers at $NODE_GYP_DIR"
    exit 1
fi

echo "✅ Using Node.js headers from: $NODE_HEADERS"

# Ensure node-addon-api is installed
if [ ! -d "node_modules/node-addon-api" ]; then
    echo "📦 Installing node-addon-api..."
    npm install node-addon-api
fi

NODE_ADDON_API=$(node -p "require('node-addon-api').include_dir")
echo "✅ Using node-addon-api from: $NODE_ADDON_API"

# Build Swift
echo "🔨 Compiling Swift module..."
swiftc -emit-object \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -o CaptureModule.o \
  -suppress-warnings \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift compilation failed"
    exit 1
fi

echo "📝 Generating Swift header..."
swiftc -emit-objc-header \
  -emit-objc-header-path CaptureModule-Swift.h \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -suppress-warnings \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift header generation failed"
    exit 1
fi

# Fix imports
echo "🔧 Fixing Swift header imports..."
sed -i '' 's/^@import.*$/\/\/ &/' CaptureModule-Swift.h

# Build C++ for Node.js (not Electron)
echo "🔨 Compiling C++ module..."
clang++ -c webrtc_wrapper.mm \
  -I. \
  -I"$NODE_ADDON_API" \
  -I"$NODE_HEADERS" \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -isysroot $(xcrun --sdk macosx --show-sdk-path) \
  -DNODE_ADDON_API_DISABLE_DEPRECATED \
  -DNAPI_DISABLE_CPP_EXCEPTIONS \
  -DBUILDING_NODE_EXTENSION \
  -Wno-nullability-completeness \
  -Wno-availability \
  -Wno-deprecated-declarations \
  -o webrtc_wrapper.o

if [ $? -ne 0 ]; then
    echo "❌ C++ compilation failed"
    exit 1
fi

# Link
echo "🔗 Linking final module..."
clang++ -o addon.node \
  webrtc_wrapper.o \
  CaptureModule.o \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -isysroot $(xcrun --sdk macosx --show-sdk-path) \
  -framework Foundation \
  -framework CoreMedia \
  -framework AVFoundation \
  -framework ScreenCaptureKit \
  -framework CoreVideo \
  -framework AppKit \
  -bundle \
  -undefined dynamic_lookup

if [ $? -ne 0 ]; then
    echo "❌ Linking failed"
    exit 1
fi

echo "✅ Built for Node.js successfully!"
echo ""
echo "📊 Module info:"
file addon.node
echo ""
echo "🧪 Testing load..."
node -e "try { require('./addon.node'); console.log('✅ Module loads correctly!'); } catch(e) { console.log('❌ Load error:', e.message); }"