const path = require('path');
const fs = require('fs');

console.log('Testing Windows module...\n');

// Проверяем существование файла
const modulePath = path.join(__dirname, 'dist-electron', 'screen_capture_win.node');
if (!fs.existsSync(modulePath)) {
    console.error(`Module not found at: ${modulePath}`);
    process.exit(1);
}

console.log(`Module found at: ${modulePath}`);
console.log(`File size: ${fs.statSync(modulePath).size} bytes\n`);

try {
    // Загружаем модуль
    const nativeModule = require(modulePath);
    
    console.log('✅ Module loaded successfully!');
    console.log('Available methods:', Object.keys(nativeModule));
    
    // Тестируем методы
    if (nativeModule.testMethod) {
        console.log('\nTest method:', nativeModule.testMethod());
    }
    
    if (nativeModule.getAvailableSources) {
        const sources = nativeModule.getAvailableSources();
        console.log('\nAvailable sources:', sources);
    }
    
    // Тестируем захват
    if (nativeModule.startCapture && nativeModule.stopCapture) {
        console.log('\nTesting capture...');
        const startResult = nativeModule.startCapture();
        console.log('Start capture:', startResult);
        
        const stopResult = nativeModule.stopCapture();
        console.log('Stop capture:', stopResult);
    }
    
} catch (error) {
    console.error('❌ Error loading module:', error.message);
    console.error('Stack:', error.stack);
}