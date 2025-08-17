const { app } = require('electron');
const path = require('path');

app.whenReady().then(() => {
    console.log('🚀 Electron ready, testing audio capture...\n');
    
    const addon = require('./addon.node');
    console.log('✅ Module loaded in Electron\n');
    
    let audioCount = 0;
    let systemCount = 0;
    let micCount = 0;
    
    // Set audio callback
    addon.setWebRTCAudioCallback((audioData) => {
        audioCount++;
        
        const hasData = audioData.data !== undefined;
        const dataSize = audioData.dataByteLength || 0;
        const source = audioData.source || 'unknown';
        
        if (source === 'system') systemCount++;
        if (source === 'microphone') micCount++;
        
        if (audioCount <= 5 || audioCount % 10 === 0) {
            console.log(`🎵 Frame ${audioCount}:`);
            console.log(`   Source: ${source}`);
            console.log(`   Has data: ${hasData ? '✅' : '❌'}`);
            console.log(`   Size: ${dataSize} bytes`);
            console.log(`   Totals: System=${systemCount}, Mic=${micCount}`);
            
            if (!hasData) {
                console.log('   ⚠️ WARNING: Missing data field!');
            }
            console.log('');
        }
    });
    
    // Get sources and start capture
    addon.getAvailableSources().then(async (sources) => {
        const display = sources.find(s => s.type === 'display');
        if (!display) {
            console.error('No display found');
            app.quit();
            return;
        }
        
        console.log(`📺 Using: ${display.name}\n`);
        
        try {
            await addon.setCaptureSource('display', display.id);
            await addon.startAudioOnlyCapture();
            console.log('✅ Audio capture started!\n');
            console.log('🎧 Play some audio to test...\n');
            
            // Quit after 10 seconds
            setTimeout(() => {
                console.log('\n📊 Final stats:');
                console.log(`   Total: ${audioCount}`);
                console.log(`   System: ${systemCount}`);
                console.log(`   Mic: ${micCount}`);
                addon.stopCapture().then(() => {
                    console.log('✅ Stopped');
                    app.quit();
                });
            }, 10000);
            
        } catch (error) {
            console.error('Error:', error);
            app.quit();
        }
    });
});

app.on('window-all-closed', () => {
    app.quit();
});