#!/usr/bin/env node

console.log('🧪 Testing macOS native module...\n');

const path = require('path');
const fs = require('fs');

// Ищем модуль
const modulePaths = [
    './addon.node',
    './build/Release/addon.node',
    path.join(__dirname, 'addon.node'),
    path.join(__dirname, 'build', 'Release', 'addon.node')
];

let modulePath = null;
for (const p of modulePaths) {
    if (fs.existsSync(p)) {
        modulePath = p;
        break;
    }
}

if (!modulePath) {
    console.error('❌ Module not found. Run: npm run build');
    process.exit(1);
}

console.log(`📦 Found module at: ${modulePath}`);
console.log(`📊 Size: ${(fs.statSync(modulePath).size / 1024).toFixed(2)} KB`);

// Проверяем архитектуру
const { execSync } = require('child_process');
try {
    const fileInfo = execSync(`file ${modulePath}`).toString();
    console.log(`🔍 Type: ${fileInfo.trim()}`);
} catch (e) {}

// Пробуем загрузить
try {
    const addon = require(modulePath);
    console.log('✅ Module loaded successfully!\n');
    
    // Проверяем методы
    const methods = Object.keys(addon).filter(k => typeof addon[k] === 'function');
    console.log('📋 Available methods:');
    methods.forEach(m => console.log(`   ✅ ${m}`));
    
    // Тестируем
    if (addon.testMethod) {
        console.log('\n📝 Test:', addon.testMethod());
    }
    
    if (addon.getAvailableSources) {
        console.log('\n🖥️ Getting sources...');
        const sources = addon.getAvailableSources();
        console.log(`Found ${sources.length} sources`);
    }
    
} catch (error) {
    console.error('❌ Failed to load:', error.message);
    
    if (error.message.includes('NODE_MODULE_VERSION')) {
        console.log('\n⚠️ Version mismatch - this is expected when testing outside Electron');
        console.log('The module should work fine in Electron environment');
    }
}

console.log('\n✅ Test complete!');