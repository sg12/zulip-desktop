// test-window-ids.js
const { app } = require('electron');

app.whenReady().then(async () => {
    const addon = require('./addon.node');
    
    // Получаем список источников из нативного модуля
    const sources = await addon.getAvailableSources();
    
    console.log('='.repeat(60));
    console.log('NATIVE MODULE SOURCES:');
    console.log('='.repeat(60));
    
    sources.forEach((source, index) => {
        if (source.type === 'window') {
            console.log(`Window ${index}:`);
            console.log(`  Name: ${source.name}`);
            console.log(`  ID: ${source.id}`);
            console.log(`  App: ${source.appName || 'Unknown'}`);
            console.log(`  Size: ${source.width}x${source.height}`);
            console.log('');
        }
    });
    
    console.log('='.repeat(60));
    console.log('DISPLAYS:');
    console.log('='.repeat(60));
    
    sources.forEach((source, index) => {
        if (source.type === 'display') {
            console.log(`Display ${index}:`);
            console.log(`  Name: ${source.name}`);
            console.log(`  ID: ${source.id}`);
            console.log(`  Size: ${source.width}x${source.height}`);
            console.log('');
        }
    });
    
    app.quit();
});