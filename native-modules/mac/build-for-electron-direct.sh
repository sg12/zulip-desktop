#!/bin/bash

echo "🚀 Building WebRTC Screen Capture Module for Electron 32.3.3 (Direct Build)..."

# Electron 32.3.3 specific configuration
ELECTRON_VERSION="32.3.3"
NODE_VERSION="20.17.0"  # Electron 32.3.3 uses Node.js 20.17.0

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    TARGET_ARCH="arm64"
    echo "📱 Detected Apple Silicon (arm64)"
else
    TARGET_ARCH="x86_64"
    echo "💻 Detected Intel (x86_64)"
fi

# Get current macOS version
MACOS_VERSION=$(sw_vers -productVersion | cut -d '.' -f 1,2)
echo "🍎 macOS Version: $MACOS_VERSION"
echo "⚡ Target Electron: $ELECTRON_VERSION"
echo "🟢 Target Node.js: $NODE_VERSION"

# Check if electron is installed
if ! command -v npx &> /dev/null || ! npx electron --version &> /dev/null; then
    echo "📦 Electron not found, installing..."
    npm install electron@$ELECTRON_VERSION --save-dev
fi

# Find Electron's Node.js headers
echo "📡 Locating Electron headers..."
ELECTRON_HEADERS_DIR="$HOME/.electron-gyp/$ELECTRON_VERSION"

# Download headers if they don't exist
if [ ! -d "$ELECTRON_HEADERS_DIR" ]; then
    echo "📥 Downloading Electron $ELECTRON_VERSION headers..."
    # Use node-gyp to download headers
    npx node-gyp install --target=$ELECTRON_VERSION --arch=$TARGET_ARCH --dist-url=https://electronjs.org/headers
fi

# Set up paths
if [ -d "$ELECTRON_HEADERS_DIR/include/node" ]; then
    NODE_HEADERS_PATH="$ELECTRON_HEADERS_DIR/include/node"
    echo "✅ Found Electron headers at: $NODE_HEADERS_PATH"
else
    echo "❌ Could not find Electron headers"
    exit 1
fi

# Clean previous builds
rm -f *.o addon.node CaptureModule-Swift.h swift_integrated_capture.mm

echo "🏗️  Building for Electron $ELECTRON_VERSION with Node.js $NODE_VERSION..."

echo "Step 1: Compile Swift module for $TARGET_ARCH..."
swiftc -emit-object \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -o CaptureModule.o \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift compilation failed"
    exit 1
fi

echo "Step 2: Generate Swift header for $TARGET_ARCH..."
swiftc -emit-objc-header \
  -emit-objc-header-path CaptureModule-Swift.h \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift header generation failed"
    exit 1
fi

echo "Step 3: Prepare C++ wrapper..."
cp webrtc_wrapper.mm swift_integrated_capture.mm

echo "Step 4: Fix Swift header module imports..."
sed -i '' 's/^@import.*$/\/\/ &/' CaptureModule-Swift.h

echo "Step 5: Compile C++ module for Electron..."
clang++ -c swift_integrated_capture.mm \
  -I. \
  -I$(node -p "require('node-addon-api').include_dir") \
  -I"$NODE_HEADERS_PATH" \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -isysroot $(xcrun --sdk macosx --show-sdk-path) \
  -DNODE_ADDON_API_DISABLE_DEPRECATED \
  -DNAPI_DISABLE_CPP_EXCEPTIONS \
  -DELECTRON_BUILD \
  -DBUILDING_NODE_EXTENSION \
  -DV8_DEPRECATION_WARNINGS=1 \
  -D_DARWIN_USE_64_BIT_INODE=1 \
  -D_LARGEFILE_SOURCE \
  -D_FILE_OFFSET_BITS=64 \
  -DUSING_ELECTRON_CONFIG_GYPI \
  -Wno-nullability-completeness \
  -Wno-availability \
  -Wno-deprecated-declarations \
  -Wno-cast-function-type-mismatch

if [ $? -ne 0 ]; then
    echo "❌ C++ compilation failed"
    exit 1
fi

echo "Step 6: Link final module for Electron..."
clang++ -o addon.node \
  swift_integrated_capture.o \
  CaptureModule.o \
  -I. \
  -I$(node -p "require('node-addon-api').include_dir") \
  -I"$NODE_HEADERS_PATH" \
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

echo "✅ Electron build successful!"
echo ""
echo "🎉 Your WebRTC Screen Capture module is ready for Electron $ELECTRON_VERSION!"
echo "📱 Built for: $TARGET_ARCH"
echo "🍎 Target: macOS $MACOS_VERSION"
echo "⚡ Electron: $ELECTRON_VERSION"
echo "🟢 Node.js: $NODE_VERSION"
echo ""
echo "🔍 Verifying built module architecture:"
file addon.node

echo ""
echo "📹 Features:"
echo "   ✓ Screen capture with ScreenCaptureKit"
echo "   ✓ Real-time video/audio frame callbacks"
echo "   ✓ WebRTC-ready pixel buffer processing"
echo "   ✓ Electron $ELECTRON_VERSION compatibility"
echo "   ✓ Architecture-matched compilation"
echo ""
echo "🧪 Testing module load..."
node -e "try { require('./addon.node'); console.log('✅ Module loads in Node.js'); } catch(e) { console.log('⚠️  Module load test:', e.message); }"

echo ""
echo "🚀 Next steps:"
echo "   1. Test in Electron: npx electron electron-test-main.js"
echo "   2. The module should work properly in Electron context"
echo "   3. Screen sharing picker should appear in Electron!"

# Clean up temporary files
rm -f swift_integrated_capture.mm swift_integrated_capture.o

echo ""
echo "💡 This build bypasses electron-rebuild and builds directly for Electron"
echo "   Use this approach when node-gyp/electron-rebuild has issues with Swift files"
