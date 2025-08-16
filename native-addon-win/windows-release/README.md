# Windows Screen Capture Module

Native screen capture module for Windows, designed for Electron applications.

## Requirements
- Windows 10/11 (x64)
- Node.js 16+ or Electron 20+
- Visual C++ Redistributables (usually already installed)

## Installation

Just copy this folder to your Electron project.

## Usage

### Basic Example
```javascript
const ScreenCapture = require('./windows-screen-capture');

const capture = new ScreenCapture();

// Get available sources
const sources = capture.getSources();
console.log('Available sources:', sources);

// Select a source
capture.selectSource('display', '0');

// Set up callbacks
capture.onVideoFrame((frame) => {
    console.log(`Frame: ${frame.width}x${frame.height}`);
    // Process frame.data (ArrayBuffer with BGRA pixels)
});

capture.onAudioFrame((audio) => {
    console.log(`Audio: ${audio.samples} samples`);
    // Process audio data
});

// Start capturing
capture.start();

// Stop after some time
setTimeout(() => capture.stop(), 10000);