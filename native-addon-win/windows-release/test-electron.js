// Test for Electron environment
const ScreenCapture = require('./index.js');

console.log('=== Windows Screen Capture Test ===\n');

try {
    // Создаем экземпляр
    const capture = new ScreenCapture();
    console.log('✅ Module initialized\n');

    // Получаем источники
    console.log('📋 Available sources:');
    const sources = capture.getSources();
    sources.forEach((source, index) => {
        console.log(`  ${index + 1}. [${source.type}] ${source.name} (${source.width}x${source.height})`);
    });

    if (sources.length > 0) {
        // Выбираем первый источник
        const firstSource = sources[0];
        console.log(`\n🎯 Selecting: ${firstSource.name}`);
        capture.selectSource(firstSource.type, firstSource.id);

        // Устанавливаем callbacks
        let frameCount = 0;
        capture.onVideoFrame((frame) => {
            frameCount++;
            if (frameCount % 30 === 0) { // Логируем каждый 30й кадр
                console.log(`📹 Video frame ${frameCount}: ${frame.width}x${frame.height}`);
            }
        });

        capture.onAudioFrame((audio) => {
            console.log(`🔊 Audio: ${audio.samples} samples`);
        });

        // Начинаем захват
        console.log('\n▶️  Starting capture...');
        capture.start();

        // Останавливаем через 5 секунд
        setTimeout(() => {
            console.log('\n⏹️  Stopping capture...');
            capture.stop();
            
            const stats = capture.getStats();
            console.log('\n📊 Final statistics:', stats);
            
            process.exit(0);
        }, 5000);
    }

} catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
}
