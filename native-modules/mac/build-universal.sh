#!/bin/bash

echo "🚀 Building Universal Binary for WebRTC Screen Capture Module..."
echo "=================================================="

# Configuration
ELECTRON_VERSION="32.3.3"
NODE_VERSION="20.17.0"

# Detect macOS version
MACOS_VERSION=$(sw_vers -productVersion | cut -d '.' -f 1,2)
echo "🍎 macOS Version: $MACOS_VERSION"
echo "⚡ Target Electron: $ELECTRON_VERSION"
echo "🟢 Target Node.js: $NODE_VERSION"

# Clean previous builds
echo ""
echo "🧹 Cleaning previous builds..."
rm -rf build/
rm -f *.o addon.node CaptureModule-Swift.h swift_integrated_capture.mm
mkdir -p build/x64 build/arm64

# Check and install node-addon-api if needed
if [ ! -d "node_modules/node-addon-api" ]; then
    echo "📦 Installing node-addon-api..."
    npm install node-addon-api
fi

# Get node-addon-api include directory
NODE_ADDON_API_DIR=$(node -p "require('node-addon-api').include_dir")
echo "📍 node-addon-api location: $NODE_ADDON_API_DIR"

# Check if electron is installed
if ! command -v npx &> /dev/null || ! npx electron --version &> /dev/null; then
    echo "📦 Electron not found, installing..."
    npm install electron@$ELECTRON_VERSION --save-dev
fi

# Find Electron's Node.js headers
echo ""
echo "📡 Locating Electron headers..."
ELECTRON_HEADERS_DIR="$HOME/.electron-gyp/$ELECTRON_VERSION"

if [ ! -d "$ELECTRON_HEADERS_DIR" ]; then
    echo "📥 Downloading Electron $ELECTRON_VERSION headers..."
    npx node-gyp install --target=$ELECTRON_VERSION --arch=x64 --dist-url=https://electronjs.org/headers
    npx node-gyp install --target=$ELECTRON_VERSION --arch=arm64 --dist-url=https://electronjs.org/headers
fi

# Find headers path
if [ -d "$ELECTRON_HEADERS_DIR/include/node" ]; then
    NODE_HEADERS_PATH="$ELECTRON_HEADERS_DIR/include/node"
elif [ -d "$ELECTRON_HEADERS_DIR" ]; then
    NODE_HEADERS_PATH="$ELECTRON_HEADERS_DIR"
else
    NODE_GYP_DIR="$HOME/.node-gyp/$NODE_VERSION"
    if [ -d "$NODE_GYP_DIR/include/node" ]; then
        NODE_HEADERS_PATH="$NODE_GYP_DIR/include/node"
    else
        echo "⚠️ Downloading Node.js headers as fallback..."
        npx node-gyp install
        NODE_HEADERS_PATH="$HOME/.node-gyp/$(node -v | sed 's/v//')/include/node"
    fi
fi

echo "✅ Using headers at: $NODE_HEADERS_PATH"

echo ""
echo "=========================================="
echo "📱 Building for ARM64 (Apple Silicon)"
echo "=========================================="

# Step 1: Compile Swift for ARM64
echo "Step 1/6: Compiling Swift module for ARM64..."
swiftc -emit-object \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target arm64-apple-macos${MACOS_VERSION} \
  -o build/arm64/CaptureModule.o \
  -suppress-warnings \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift compilation for ARM64 failed"
    exit 1
fi

# Step 2: Generate Swift header for ARM64
echo "Step 2/6: Generating Swift header for ARM64..."
swiftc -emit-objc-header \
  -emit-objc-header-path build/arm64/CaptureModule-Swift.h \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target arm64-apple-macos${MACOS_VERSION} \
  -suppress-warnings \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift header generation for ARM64 failed"
    exit 1
fi

# Step 3: Prepare and compile C++ for ARM64
echo "Step 3/6: Compiling C++ module for ARM64..."

# Copy webrtc_wrapper.mm to build directory
cp webrtc_wrapper.mm build/arm64/swift_integrated_capture.mm

# Copy and fix the Swift header
cp build/arm64/CaptureModule-Swift.h ./CaptureModule-Swift.h

# Fix @import statements in the Swift header using perl (more reliable than sed on macOS)
echo "   Fixing Swift header imports..."
perl -i -pe 's/^(\@import .+;)$/\/\/ $1/g' CaptureModule-Swift.h

# Verify the fix
echo "   Checking for unfixed @import statements..."
if grep "^@import" CaptureModule-Swift.h; then
    echo "   ⚠️ Found unfixed @import statements, attempting alternative fix..."
    # Alternative approach: use a temporary file
    grep -v "^@import" CaptureModule-Swift.h > CaptureModule-Swift-fixed.h
    mv CaptureModule-Swift-fixed.h CaptureModule-Swift.h
fi

# Also fix the header in build directory for consistency
cp CaptureModule-Swift.h build/arm64/CaptureModule-Swift.h

# Compile C++
clang++ -c build/arm64/swift_integrated_capture.mm \
  -target arm64-apple-macos${MACOS_VERSION} \
  -arch arm64 \
  -I. \
  -I"$NODE_ADDON_API_DIR" \
  -I"$NODE_HEADERS_PATH" \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
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
  -Wno-cast-function-type-mismatch \
  -o build/arm64/swift_integrated_capture.o

if [ $? -ne 0 ]; then
    echo "❌ C++ compilation for ARM64 failed"
    echo "First 30 lines of CaptureModule-Swift.h:"
    head -30 CaptureModule-Swift.h
    exit 1
fi

# Step 4: Link ARM64 binary
echo "Step 4/6: Linking ARM64 module..."
clang++ -o build/arm64/addon.node \
  -target arm64-apple-macos${MACOS_VERSION} \
  -arch arm64 \
  build/arm64/swift_integrated_capture.o \
  build/arm64/CaptureModule.o \
  -I. \
  -I"$NODE_ADDON_API_DIR" \
  -I"$NODE_HEADERS_PATH" \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
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
    echo "❌ Linking for ARM64 failed"
    exit 1
fi

echo "✅ ARM64 build completed"

echo ""
echo "=========================================="
echo "💻 Building for x86_64 (Intel)"
echo "=========================================="

# Clean up temporary Swift header
rm -f CaptureModule-Swift.h

# Step 5: Compile Swift for x86_64
echo "Step 1/6: Compiling Swift module for x86_64..."
swiftc -emit-object \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target x86_64-apple-macos${MACOS_VERSION} \
  -o build/x64/CaptureModule.o \
  -suppress-warnings \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift compilation for x86_64 failed"
    exit 1
fi

# Step 6: Generate Swift header for x86_64
echo "Step 2/6: Generating Swift header for x86_64..."
swiftc -emit-objc-header \
  -emit-objc-header-path build/x64/CaptureModule-Swift.h \
  -module-name CaptureModule \
  -import-objc-header CaptureModule-Bridging-Header.h \
  -target x86_64-apple-macos${MACOS_VERSION} \
  -suppress-warnings \
  ScreenCaptureManager.swift

if [ $? -ne 0 ]; then
    echo "❌ Swift header generation for x86_64 failed"
    exit 1
fi

# Step 7: Prepare and compile C++ for x86_64
echo "Step 3/6: Compiling C++ module for x86_64..."

# Copy files
cp webrtc_wrapper.mm build/x64/swift_integrated_capture.mm
cp build/x64/CaptureModule-Swift.h ./CaptureModule-Swift.h

# Fix @import statements
echo "   Fixing Swift header imports..."
perl -i -pe 's/^(\@import .+;)$/\/\/ $1/g' CaptureModule-Swift.h

# Verify and alternative fix if needed
if grep "^@import" CaptureModule-Swift.h; then
    echo "   ⚠️ Found unfixed @import statements, using alternative fix..."
    grep -v "^@import" CaptureModule-Swift.h > CaptureModule-Swift-fixed.h
    mv CaptureModule-Swift-fixed.h CaptureModule-Swift.h
fi

# Copy fixed header back
cp CaptureModule-Swift.h build/x64/CaptureModule-Swift.h

# Compile C++
clang++ -c build/x64/swift_integrated_capture.mm \
  -target x86_64-apple-macos${MACOS_VERSION} \
  -arch x86_64 \
  -I. \
  -I"$NODE_ADDON_API_DIR" \
  -I"$NODE_HEADERS_PATH" \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
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
  -Wno-cast-function-type-mismatch \
  -o build/x64/swift_integrated_capture.o

if [ $? -ne 0 ]; then
    echo "❌ C++ compilation for x86_64 failed"
    exit 1
fi

# Step 8: Link x86_64 binary
echo "Step 4/6: Linking x86_64 module..."
clang++ -o build/x64/addon.node \
  -target x86_64-apple-macos${MACOS_VERSION} \
  -arch x86_64 \
  build/x64/swift_integrated_capture.o \
  build/x64/CaptureModule.o \
  -I. \
  -I"$NODE_ADDON_API_DIR" \
  -I"$NODE_HEADERS_PATH" \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
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
    echo "❌ Linking for x86_64 failed"
    exit 1
fi

echo "✅ x86_64 build completed"

echo ""
echo "=========================================="
echo "🔄 Creating Universal Binary"
echo "=========================================="

# Create universal binary
lipo -create \
  build/x64/addon.node \
  build/arm64/addon.node \
  -output addon.node

if [ $? -ne 0 ]; then
    echo "❌ Failed to create universal binary"
    exit 1
fi

# Clean up temporary files
rm -f CaptureModule-Swift.h swift_integrated_capture.mm

echo ""
echo "=========================================="
echo "✅ Universal Binary Created Successfully!"
echo "=========================================="
echo ""
echo "📊 Verifying universal binary:"
file addon.node
echo ""
lipo -info addon.node
echo ""

# Verify architectures
ARCHS=$(lipo -archs addon.node)
if [[ $ARCHS == *"x86_64"* ]] && [[ $ARCHS == *"arm64"* ]]; then
    echo "✅ Both architectures verified!"
else
    echo "⚠️  Warning: Expected both x86_64 and arm64, but got: $ARCHS"
fi

echo ""
echo "📏 File sizes:"
ls -lh build/x64/addon.node | awk '{print "   x86_64:  " $5}'
ls -lh build/arm64/addon.node | awk '{print "   ARM64:   " $5}'
ls -lh addon.node | awk '{print "   Universal: " $5}'

echo ""
echo "🎉 Your WebRTC Screen Capture module is ready!"

echo ""
echo "🧪 Testing module load..."
node -e "try { require('./addon.node'); console.log('✅ Module loads in Node.js'); } catch(e) { console.log('⚠️  Module load test:', e.message); }"

echo ""
echo "Done! 🎊"