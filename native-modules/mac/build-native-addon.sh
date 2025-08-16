#!/bin/bash
# build-native-addon.sh
# Place this in the root of your zulip-desktop project

echo "Building native screen capture addon..."

# Navigate to native-addon directory
cd ../native-addon

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf build

# Build the addon
echo "Building native addon..."
npm run build

# Check if build was successful
if [ -f "build/Release/screen_capture.node" ]; then
    echo "✅ Native addon built successfully"
    
    # Copy to Electron project
    echo "Copying addon to Electron project..."
    mkdir -p ../zulip-desktop/native-addon/build/Release
    cp build/Release/screen_capture.node ../zulip-desktop/native-addon/build/Release/
    
    echo "✅ Native addon copied to Electron project"
else
    echo "❌ Native addon build failed"
    exit 1
fi

# Return to Electron directory
cd ../zulip-desktop

echo "✅ Native addon setup complete"
