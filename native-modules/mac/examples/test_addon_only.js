const path = require('path');

// Try to load the addon
let addon;
try {
    addon = require('../addon.node');
    console.log('✅ Addon loaded successfully');
} catch (error) {
    console.log('❌ Failed to load addon:', error.message);
    console.log('Run: npm run build');
    process.exit(1);
}

console.log('🧪 Testing native addon...');

// Test basic interface
console.log('1. Testing testMethod:');
try {
    const result = addon.testMethod();
    console.log('   ✅', result);
} catch (error) {
    console.log('   ❌', error.message);
}

// Test frame stats
console.log('2. Testing getFrameStats:');
try {
    const stats = addon.getFrameStats();
    console.log('   ✅ Stats:', stats);
} catch (error) {
    console.log('   ❌', error.message);
}

// Test setting up counters
console.log('3. Testing counter setup:');
try {
    const videoResult = addon.setWebRTCVideoCallback(() => {});
    console.log('   ✅ Video callback:', videoResult);
    
    const audioResult = addon.setWebRTCAudioCallback(() => {});
    console.log('   ✅ Audio callback:', audioResult);
} catch (error) {
    console.log('   ❌', error.message);
}

console.log('');
console.log('🎉 Basic tests completed!');
console.log('📝 To test actual capture, run the Electron example');
