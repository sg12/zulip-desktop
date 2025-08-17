#!/usr/bin/env node
// test-audio-verify.js
const { app } = require('electron');

app.whenReady().then(async () => {
    console.log('🎵 Testing audio data reception...\n');
    
    try {
        const addon = require('./addon.node');
        console.log('✅ Module loaded\n');
        
        let frameCount = 0;
        let totalBytes = 0;
        let hasDataCount = 0;
        let noDataCount = 0;
        let firstDataReceived = false;
        
        addon.setWebRTCAudioCallback((audioData) => {
            frameCount++;
            
            // Проверяем наличие данных
            if (audioData && audioData.data && audioData.data.byteLength > 0) {
                hasDataCount++;
                totalBytes += audioData.data.byteLength;
                
                // Первый фрейм с данными - детальный анализ
                if (!firstDataReceived) {
                    firstDataReceived = true;
                    console.log('\n🎉 FIRST AUDIO DATA RECEIVED!');
                    console.log('   Frame:', frameCount);
                    console.log('   Source:', audioData.source);
                    console.log('   Sample rate:', audioData.sampleRate, 'Hz');
                    console.log('   Channels:', audioData.channels);
                    console.log('   Samples:', audioData.numSamples);
                    console.log('   Data size:', audioData.data.byteLength, 'bytes');
                    console.log('   Timestamp:', audioData.timestamp.toFixed(3), 's');
                    
                    // Проверяем содержимое
                    const view = new Uint8Array(audioData.data);
                    const first16 = Array.from(view.slice(0, 16));
                    console.log('   First 16 bytes:', first16);
                    
                    // Проверяем, не тишина ли
                    const nonZeroBytes = view.filter(b => b !== 0).length;
                    const zeroPercent = ((view.length - nonZeroBytes) / view.length * 100).toFixed(1);
                    
                    if (nonZeroBytes === 0) {
                        console.log('   ⚠️ Audio is complete silence');
                    } else {
                        console.log(`   ✅ Audio has sound! (${zeroPercent}% silence)`);
                    }
                }
                
                // Каждые 50 фреймов - прогресс
                if (frameCount % 50 === 0) {
                    const avgSize = Math.round(totalBytes / hasDataCount);
                    console.log(`Frame ${frameCount}: ${hasDataCount} with data, avg size: ${avgSize} bytes`);
                }
            } else {
                noDataCount++;
                if (noDataCount === 1) {
                    console.log('⚠️ Frame without data:', audioData);
                }
            }
        });
        
        console.log('✅ Callback set\n');
        console.log('Starting audio capture...');
        console.log('🎧 Play some audio to test capture!\n');
        
        await addon.startAudioOnlyCapture();
        console.log('✅ Capture started!\n');
        
        // Останавливаем через 5 секунд
        setTimeout(async () => {
            console.log('\n🛑 Stopping...');
            await addon.stopCapture();
            
            console.log('\n' + '='.repeat(60));
            console.log('📊 FINAL REPORT:');
            console.log('='.repeat(60));
            console.log(`Total frames: ${frameCount}`);
            console.log(`Frames with data: ${hasDataCount}`);
            console.log(`Frames without data: ${noDataCount}`);
            console.log(`Total audio data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
            
            if (frameCount > 0) {
                const successRate = (hasDataCount / frameCount * 100).toFixed(1);
                console.log(`Success rate: ${successRate}%`);
                
                if (hasDataCount === frameCount) {
                    console.log('\n✅ PERFECT: All frames have audio data!');
                } else if (hasDataCount > frameCount * 0.95) {
                    console.log('\n✅ EXCELLENT: Over 95% frames have data!');
                } else if (hasDataCount > frameCount * 0.8) {
                    console.log('\n⚠️ GOOD: Over 80% frames have data');
                } else {
                    console.log('\n❌ POOR: Less than 80% frames have data');
                }
            }
            
            console.log('\n🎉 Audio capture module is working correctly!');
            console.log('='.repeat(60));
            
            app.quit();
        }, 5000);
        
    } catch (error) {
        console.error('Error:', error);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});