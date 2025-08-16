#!/bin/bash

echo "🔧 Comprehensive fix for architecture and syntax issues..."

# Detect the actual architecture we're running on
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    TARGET_ARCH="arm64"
    echo "📱 Detected Apple Silicon (arm64)"
else
    TARGET_ARCH="x86_64"
    echo "💻 Detected Intel (x86_64)"
fi

# Get current macOS version for consistent targeting
MACOS_VERSION=$(sw_vers -productVersion | cut -d '.' -f 1,2)
echo "🍎 macOS Version: $MACOS_VERSION"

# Fix syntax errors in all .mm files
echo "🔧 Fixing Objective-C syntax errors in all .mm files..."

for file in *.mm; do
    if [ -f "$file" ]; then
        echo "Processing $file..."
        
        # Create backup
        cp "$file" "${file}.backup"
        
        # Fix CMSampleBuffer parameter syntax - this is the main issue
        sed -i '' 's/\^(CMSampleBuffer buffer)/^(CMSampleBufferRef sampleBuffer)/g' "$file"
        
        # Fix CVPixelBuffer parameter syntax
        sed -i '' 's/\^(CVPixelBuffer pixelBuffer)/^(CVPixelBufferRef pixelBuffer)/g' "$file"
        
        # Fix any variable name references that might have changed
        sed -i '' 's/CMSampleBufferGetPresentationTimeStamp(buffer)/CMSampleBufferGetPresentationTimeStamp(sampleBuffer)/g' "$file"
        sed -i '' 's/CMSampleBufferGetFormatDescription(buffer)/CMSampleBufferGetFormatDescription(sampleBuffer)/g' "$file"
        sed -i '' 's/CMSampleBufferGetDataBuffer(buffer)/CMSampleBufferGetDataBuffer(sampleBuffer)/g' "$file"
        
        echo "✅ Fixed syntax in $file"
    fi
done

# Clean previous builds
rm -f *.o addon.node CaptureModule-Swift.h swift_integrated_capture.mm

echo "🏗️  Building with correct architecture ($TARGET_ARCH)..."

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

echo "Step 3: Copy and prepare WebRTC C++ wrapper..."
cp webrtc_wrapper.mm swift_integrated_capture.mm

echo "Step 4: Fix Swift header module imports..."
sed -i '' 's/^@import.*$/\/\/ &/' CaptureModule-Swift.h

echo "Step 5: Compile C++ module for $TARGET_ARCH..."
clang++ -c swift_integrated_capture.mm \
  -I. \
  -I$(node -p "require('node-addon-api').include_dir") \
  -I$(node -p "path.dirname(process.execPath)")/../include/node \
  -std=c++20 \
  -fobjc-arc \
  -fobjc-arc-exceptions \
  -mmacosx-version-min=${MACOS_VERSION} \
  -target ${TARGET_ARCH}-apple-macos${MACOS_VERSION} \
  -isysroot $(xcrun --sdk macosx --show-sdk-path) \
  -Wno-nullability-completeness \
  -Wno-availability \
  -Wno-deprecated-declarations

if [ $? -ne 0 ]; then
    echo "❌ C++ compilation failed"
    exit 1
fi

echo "Step 6: Link final module for $TARGET_ARCH..."
clang++ -o addon.node \
  swift_integrated_capture.o \
  CaptureModule.o \
  -I. \
  -I$(node -p "require('node-addon-api').include_dir") \
  -I$(node -p "path.dirname(process.execPath)")/../include/node \
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
  -bundle \
  -undefined dynamic_lookup

if [ $? -ne 0 ]; then
    echo "❌ Linking failed"
    exit 1
fi

echo "✅ Complete build successful for $TARGET_ARCH!"
echo ""
echo "🎉 Your WebRTC-enabled screen capture module is ready!"
echo "📱 Built for: $TARGET_ARCH"
echo "🍎 Target: macOS $MACOS_VERSION"
echo ""
echo "📹 Features:"
echo "   ✓ Screen capture with ScreenCaptureKit"
echo "   ✓ Real-time video/audio frame callbacks"
echo "   ✓ WebRTC-ready pixel buffer processing"
echo "   ✓ Architecture-matched compilation"
echo ""
echo "🚀 Next steps:"
echo "   1. npm install wrtc ws express electron"
echo "   2. node webrtc_test.js (test native WebRTC streaming)"
echo "   3. npm run electron (test in Electron app)"

# Verify the architecture of the built module
echo ""
echo "🔍 Verifying built module architecture:"
file addon.node

# Clean up temporary files
rm -f swift_integrated_capture.mm swift_integrated_capture.o

echo ""
echo "💾 Backup files created with .backup extension in case you need to revert"
