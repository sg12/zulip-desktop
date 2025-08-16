#!/bin/bash

echo "🔧 Building native addon for Electron..."

# Clean previous builds
rm -f *.o addon.node CaptureModule-Swift.h swift_integrated_capture.mm

# Get Electron version
if command -v electron &> /dev/null; then
    ELECTRON_VERSION=$(electron -v | sed 's/v//')
    echo "📱 Found Electron version: $ELECTRON_VERSION"
else
    echo "⚠️  Electron not found, using default headers"
    ELECTRON_VERSION="37.2.1"
fi

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    TARGET_ARCH="arm64"
else
    TARGET_ARCH="x86_64"
fi

MACOS_VERSION=$(sw_vers -productVersion | cut -d '.' -f 1,2)

echo "🏗️  Building for:"
echo "   Architecture: $TARGET_ARCH"
echo "   macOS: $MACOS_VERSION"
echo "   Electron: $ELECTRON_VERSION"

# Step 1: Compile Swift module
echo "Step 1: Compiling Swift module..."
swiftc -emit-object \
  -module-name CaptureModule \
  -import-objc-header src/CaptureModule-Bridging-Header.h \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -o CaptureModule.o \
  src/ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift compilation failed"
    exit 1
fi

# Step 2: Generate Swift header
echo "Step 2: Generating Swift header..."
swiftc -emit-objc-header \
  -emit-objc-header-path CaptureModule-Swift.h \
  -module-name CaptureModule \
  -import-objc-header src/CaptureModule-Bridging-Header.h \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  src/ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift header generation failed"
    exit 1
fi

# Step 3: Prepare C++ wrapper
echo "Step 3: Preparing C++ wrapper..."
cp src/webrtc_wrapper.mm swift_integrated_capture.mm

# Fix Swift header imports (comment out @import lines)
sed -i '' 's/^@import.*$/\/\/ &/' CaptureModule-Swift.h

# Step 4: Get Node.js include paths for Electron
echo "Step 4: Getting Node.js paths..."

# Try to use node-addon-api
NODE_API_INCLUDE=""
if [ -d "node_modules/node-addon-api" ]; then
    NODE_API_INCLUDE="-I./node_modules/node-addon-api"
elif command -v node &> /dev/null; then
    NODE_API_PATH=$(node -p "require('node-addon-api').include_dir" 2>/dev/null || echo "")
    if [ ! -z "$NODE_API_PATH" ]; then
        NODE_API_INCLUDE="-I$NODE_API_PATH"
    fi
fi

# Node.js headers (try multiple locations)
NODE_INCLUDE=""
if command -v node &> /dev/null; then
    NODE_PATH=$(dirname $(dirname $(which node)))
    if [ -d "$NODE_PATH/include/node" ]; then
        NODE_INCLUDE="-I$NODE_PATH/include/node"
    elif [ -d "/usr/local/include/node" ]; then
        NODE_INCLUDE="-I/usr/local/include/node"
    fi
fi

echo "   Node API Include: $NODE_API_INCLUDE"
echo "   Node Include: $NODE_INCLUDE"

# Step 5: Compile C++
echo "Step 5: Compiling C++ for Electron..."
clang++ -c swift_integrated_capture.mm \
  -I. \
  $NODE_API_INCLUDE \
  $NODE_INCLUDE \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -isysroot $(xcrun --sdk macosx --show-sdk-path) \
  -Wno-nullability-completeness \
  -Wno-availability \
  -Wno-deprecated-declarations

if [ $? -ne 0 ]; then
    echo "❌ C++ compilation failed"
    exit 1
fi

# Step 6: Link
echo "Step 6: Linking final addon..."
clang++ -o addon.node \
  swift_integrated_capture.o \
  CaptureModule.o \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -isysroot $(xcrun --sdk macosx --show-sdk-path) \
  -framework Foundation \
  -framework CoreMedia \
  -framework AVFoundation \
  -framework ScreenCaptureKit \
  -framework CoreVideo \
  -bundle \
  -undefined dynamic_lookup

if [ $? -ne 0 ]; then
    echo "❌ Linking failed"
    exit 1
fi

echo "✅ Build successful!"
echo ""
echo "🔍 Verifying addon architecture:"
file addon.node
echo ""
echo "🚀 Addon ready to use!"

# Clean up temporary files
rm -f swift_integrated_capture.mm swift_integrated_capture.o
