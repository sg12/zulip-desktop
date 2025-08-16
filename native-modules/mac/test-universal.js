#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🧪 Universal Binary Test Suite');
console.log('==============================\n');

// Check if addon exists
const addonPath = path.join(__dirname, 'addon.node');
if (!fs.existsSync(addonPath)) {
    console.error('❌ addon.node not found. Run npm run build first.');
    process.exit(1);
}

// Check architectures
console.log('📊 Binary Architecture Info:');
try {
    const lipoInfo = execSync(`lipo -info ${addonPath}`, { encoding: 'utf8' });
    console.log(lipoInfo);
    
    // Verify both architectures are present
    if (lipoInfo.includes('x86_64') && lipoInfo.includes('arm64')) {
        console.log('✅ Universal binary confirmed (x86_64 + arm64)\n');
    } else {
        console.log('⚠️  Warning: Not a universal binary\n');
    }
} catch (e) {
    console.error('❌ Failed to check binary info:', e.message);
}

// Test loading the module
console.log('🔌 Testing Module Load:');
try {
    const addon = require('./addon.node');
    console.log('✅ Module loaded successfully');
    
    // Check current architecture
    const arch = process.arch;
    console.log(`📱 Running on: ${arch}\n`);
    
    // Test basic functionality
    console.log('🎯 Testing Basic Functions:');
    
    // Test 1: Basic test
    try {
        if (typeof addon.testBasic === 'function') {
            const result = addon.testBasic();
            console.log('✅ testBasic:', result);
        }
    } catch (e) {
        console.log('❌ testBasic failed:', e.message);
    }
    
    // Test 2: Get available sources
    try {
        if (typeof addon.getAvailableSources === 'function') {
            addon.getAvailableSources().then(sources => {
                console.log(`✅ getAvailableSources: Found ${sources.length} sources`);
                if (sources.length > 0) {
                    console.log('   First source:', {
                        type: sources[0].type,
                        name: sources[0].name,
                        id: sources[0].id
                    });
                }
            }).catch(e => {
                console.log('❌ getAvailableSources failed:', e.message);
            });
        }
    } catch (e) {
        console.log('❌ getAvailableSources error:', e.message);
    }
    
    // Test 3: Frame stats
    try {
        if (typeof addon.getFrameStats === 'function') {
            const stats = addon.getFrameStats();
            console.log('✅ getFrameStats:', stats);
        }
    } catch (e) {
        console.log('❌ getFrameStats failed:', e.message);
    }
    
    // Test 4: Audio callback
    try {
        if (typeof addon.setWebRTCAudioCallback === 'function') {
            addon.setWebRTCAudioCallback((data) => {
                console.log('✅ Audio callback registered');
            });
            console.log('✅ setWebRTCAudioCallback: Callback set');
        }
    } catch (e) {
        console.log('❌ setWebRTCAudioCallback failed:', e.message);
    }
    
    // Test 5: Video callback
    try {
        if (typeof addon.setWebRTCVideoCallback === 'function') {
            addon.setWebRTCVideoCallback((data) => {
                console.log('✅ Video callback registered');
            });
            console.log('✅ setWebRTCVideoCallback: Callback set');
        }
    } catch (e) {
        console.log('❌ setWebRTCVideoCallback failed:', e.message);
    }
    
    console.log('\n📋 Available Methods:');
    const methods = Object.keys(addon).filter(key => typeof addon[key] === 'function');
    methods.forEach(method => {
        console.log(`   • ${method}`);
    });
    
    console.log('\n✅ All basic tests completed!');
    console.log('\n💡 Run "npm run test:electron" for Electron-specific tests');
    
} catch (e) {
    console.error('❌ Failed to load module:', e.message);
    console.error('\nFull error:', e);
    process.exit(1);
}

// Check system info
console.log('\n📱 System Info:');
console.log(`   OS: ${process.platform}`);
console.log(`   Arch: ${process.arch}`);
console.log(`   Node: ${process.version}`);
console.log(`   V8: ${process.versions.v8}`);

// Provide next steps
console.log('\n🚀 Next Steps:');
console.log('   1. Test in Electron: npm run test:electron');
console.log('   2. Deploy to both Intel and ARM Macs');
console.log('   3. Monitor performance on both architectures');