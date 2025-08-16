// Main entry point for screen-capture-webrtc-native
try {
    module.exports = require('./addon.node');
} catch (error) {
    throw new Error(`
Failed to load native addon: ${error.message}

To build the addon, run:
  npm run build

Or if using with Electron:
  npm run rebuild

Make sure you have:
- Xcode command line tools installed
- macOS 13.0 or later
- Node.js 16.0 or later
`);
}
