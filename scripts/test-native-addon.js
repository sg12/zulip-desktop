#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

console.log('🧪 Testing native addon...\n');

// Определяем платформу
const platform = process.platform;
console.log(`Platform: ${platform}`);
console.log(`Node version: ${process.version}`);
console.log(`Node ABI: ${process.versions.modules}`);

// Определяем путь к модулю
const addonName = platform === 'win32' ? 'screen_capture_win.node' : 'native-addon.node';
const addonPath = path.join(__dirname, '..', 'dist-electron', addonName);

// Проверяем существование файла
if (!fs.existsSync(addonPath)) {
    console.error(`❌ Native addon not found at: ${addonPath}`);
    console.log('\nPlease run: npm run build:native\n');
    process.exit(1);
}

console.log(`✅ Found addon at: ${addonPath}`);

// Проверяем размер и тип
const stats = fs.statSync(addonPath);
console.log(`📊 Size: ${(stats.size / 1024).toFixed(2)} KB`);

// Для macOS native модуля
if (platform === 'darwin' && addonName === 'native-addon.node') {
    console.log('\n⚠️  This module is built for Electron, not Node.js');
    console.log('Testing in Electron environment...\n');
    
    // Запускаем тест в Electron
    const electronTest = spawn('npx', ['electron', 'test-electron-modules.js'], {
        stdio: 'inherit',
        shell: true
    });
    
    electronTest.on('close', (code) => {
        if (code === 0) {
            console.log('\n✅ Electron test completed successfully!');
        } else {
            console.log('\n❌ Electron test failed');
        }
    });
    
} else if (platform === 'win32' || addonName === 'screen_capture_win.node') {
    // Для Windows mock (JavaScript)
    console.log('\nTesting Windows mock module...');
    
    try {
        const moduleContent = fs.readFileSync(addonPath, 'utf8');
        
        // Проверяем, что это JavaScript
        if (moduleContent.includes('module.exports')) {
            console.log('✅ This is a JavaScript mock module');
            
            // Можем выполнить базовую проверку
            const vm = require('vm');
            const sandbox = {
                module: { exports: {} },
                exports: {},
                console: console,
                setTimeout: setTimeout,
                setInterval: setInterval,
                Buffer: Buffer,
                ArrayBuffer: ArrayBuffer,
                Promise: Promise
            };
            
            vm.createContext(sandbox);
            vm.runInContext(moduleContent, sandbox);
            
            const addon = sandbox.module.exports;
            
            if (addon.testMethod) {
                console.log('Test result:', addon.testMethod());
            }
            
            console.log('Available methods:', Object.keys(addon).filter(k => typeof addon[k] === 'function').join(', '));
            
            console.log('\n✅ Mock module test passed!');
        }
    } catch (error) {
        console.error('Error testing module:', error.message);
    }
}
