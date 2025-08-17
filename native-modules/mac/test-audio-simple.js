#!/usr/bin/env node
const { app } = require('electron');

app.whenReady().then(async () => {
    console.log('🚀 Starting simple audio test...\n');
    
    try {
        const addon = require('./addon.node');
        console.log('✅ Module loaded\n');
        
        let audioCount = 0;
        
        // Устанавливаем audio callback
        console.log('Setting audio callback...');
        addon.setWebRTCAudioCallback((audioData) => {
            audioCount++;
            const source = audioData.source || 'unknown';
            const hasData = audioData.data !== undefined;
            const size = audioData.dataByteLength || 0;
            
            if (audioCount <= 5 || audioCount % 10 === 0) {
                console.log(`Frame ${audioCount}: ${source}, has data: ${hasData}, size: ${size}`);
            }
        });
        console.log('✅ Audio callback set\n');
        
        // Получаем источники
        console.log('Getting sources...');
        const sources = await addon.getAvailableSources();
        console.log(`Found ${sources.length} sources\n`);
        
        // Находим display
        const display = sources.find(s => s.type === 'display');
        if (!display) {
            console.error('No display found');
            app.quit();
            return;
        }
        
        console.log(`Display found: ${display.name} (ID: ${display.id})\n`);
        
        // ВАЖНО: Используем простые строки, без объектов
        const typeStr = 'display';
        const idStr = String(display.id); // Преобразуем в строку явно
        
        console.log(`Calling setCaptureSourceSimple("${typeStr}", "${idStr}")...`);
        
        try {
            // Используем setCaptureSourceSimple
            if (addon.setCaptureSourceSimple) {
                await addon.setCaptureSourceSimple(typeStr, idStr);
                console.log('✅ Source set with setCaptureSourceSimple\n');
            } else {
                console.log('setCaptureSourceSimple not found, trying setCaptureSource...');
                // Fallback на обычную версию
                await addon.setCaptureSource(typeStr, idStr);
                console.log('✅ Source set with setCaptureSource\n');
            }
        } catch (error) {
            console.error('Error setting source:', error);
            app.quit();
            return;
        }
        
        // Запускаем захват
        console.log('Starting audio capture...');
        await addon.startAudioOnlyCapture();
        console.log('✅ Audio capture started!\n');
        
        console.log('🎧 Listening for 10 seconds...\n');
        
        // Останавливаем через 10 секунд
        setTimeout(async () => {
            console.log('\nStopping...');
            await addon.stopCapture();
            console.log(`Total frames: ${audioCount}`);
            app.quit();
        }, 10000);
        
    } catch (error) {
        console.error('Fatal error:', error);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});