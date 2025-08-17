#!/usr/bin/env node
const { app } = require('electron');

app.whenReady().then(() => {
    console.log('Testing module exports...\n');
    
    try {
        const addon = require('./addon.node');
        console.log('Available functions:');
        
        const functions = Object.keys(addon).filter(key => typeof addon[key] === 'function');
        functions.forEach(func => {
            console.log(`  - ${func}`);
        });
        
        // Проверяем наличие SetCaptureSourceSimple
        if (addon.setCaptureSourceSimple) {
            console.log('\n✅ setCaptureSourceSimple is available!');
        } else {
            console.log('\n❌ setCaptureSourceSimple NOT found');
        }
        
    } catch (error) {
        console.error('Error:', error);
    }
    
    app.quit();
});