// Test native modules in Electron environment
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

console.log('🧪 Testing native modules in Electron...\n');
console.log(`Electron: ${process.versions.electron}`);
console.log(`Node: ${process.versions.node}`);
console.log(`Node ABI: ${process.versions.modules}`);
console.log(`Platform: ${process.platform}`);
console.log(`Architecture: ${process.arch}\n`);

app.whenReady().then(() => {
    // Test macOS module
    if (process.platform === 'darwin') {
        console.log('🍎 Testing macOS module...');
        try {
            const macModule = require('./dist-electron/native-addon.node');
            console.log('✅ macOS module loaded successfully in Electron!');
            
            if (macModule.testMethod) {
                console.log('   Test:', macModule.testMethod());
            }
            
            if (macModule.testBasic) {
                console.log('   Basic:', macModule.testBasic());
            }
            
            if (macModule.getAvailableSources) {
                const sources = macModule.getAvailableSources();
                console.log(`   Found ${sources.length} sources`);
                if (sources.length > 0) {
                    console.log(`   First source: ${sources[0].name}`);
                }
            }
            
            // Проверяем все методы
            const methods = Object.keys(macModule).filter(k => typeof macModule[k] === 'function');
            console.log(`   Available methods: ${methods.join(', ')}`);
            
        } catch (error) {
            console.error('❌ macOS module error:', error.message);
        }
    }
    
    console.log('\n✅ Test complete! Closing in 3 seconds...');
    
    setTimeout(() => {
        app.quit();
    }, 3000);
});

app.on('window-all-closed', () => {
    app.quit();
});
