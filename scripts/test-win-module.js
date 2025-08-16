#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const vm = require('vm');

console.log('🧪 Testing Windows module...\n');

const modulePath = path.join(__dirname, '..', 'dist-electron', 'screen_capture_win.node');

if (!fs.existsSync(modulePath)) {
    console.error('❌ Module not found. Run: npm run build:native:win');
    process.exit(1);
}

// Проверяем, что это бинарный файл
const stats = fs.statSync(modulePath);
console.log(`📊 Module size: ${(stats.size / 1024).toFixed(2)} KB`);

// Читаем первые байты файла
const buffer = fs.readFileSync(modulePath);
const header = buffer.slice(0, 2).toString('hex');

if (header === '4d5a') { // MZ header для Windows PE
    console.log('✅ Valid Windows PE executable detected');
    console.log('📝 Note: Cannot load Windows binary on macOS');
} else {
    console.log('ℹ️ This is a JavaScript mock module');
    
    if (process.platform === 'darwin') {
        console.log('📝 Testing mock module on macOS...\n');
        
        // Загружаем JavaScript mock как текст и выполняем
        try {
            const moduleCode = fs.readFileSync(modulePath, 'utf8');
            
            // Создаем контекст для выполнения
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
            
            // Выполняем код модуля
            vm.createContext(sandbox);
            vm.runInContext(moduleCode, sandbox);
            
            const addon = sandbox.module.exports;
            console.log('✅ Mock module loaded successfully!');
            
            // Тестируем методы
            if (addon.testMethod) {
                console.log('📝 Test method:', addon.testMethod());
            }
            
            // Тестируем getAvailableSources
            if (addon.getAvailableSources) {
                addon.getAvailableSources().then(sources => {
                    console.log(`📺 Found ${sources.length} mock sources:`);
                    sources.forEach(s => {
                        console.log(`   - ${s.name} (${s.type})`);
                    });
                }).catch(err => {
                    console.error('Error getting sources:', err);
                });
            }
            
            // Проверяем наличие всех методов
            const requiredMethods = [
                'testMethod',
                'getAvailableSources', 
                'setCaptureSource',
                'setCaptureQuality',
                'startCapture',
                'stopCapture',
                'setWebRTCVideoCallback',
                'setWebRTCAudioCallback'
            ];
            
            console.log('\n📋 Method check:');
            requiredMethods.forEach(method => {
                const exists = typeof addon[method] === 'function';
                console.log(`   ${exists ? '✅' : '❌'} ${method}`);
            });
            
        } catch (error) {
            console.error('❌ Failed to load mock:', error.message);
        }
    }
}

console.log('\n✅ Windows module test complete!');