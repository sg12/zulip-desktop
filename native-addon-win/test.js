const capture = require('./screen_capture_win.node');

const captureModule = new capture.ScreenCaptureModule();

// Получаем доступные источники
const sources = captureModule.getAvailableSources();
console.log('Available sources:', sources);

// Устанавливаем источник (первый монитор)
if (sources.length > 0) {
    captureModule.setCaptureSource(sources[0].type, sources[0].id);
    
    // Устанавливаем callback для видео
    captureModule.setVideoCallback((frame) => {
        console.log(`Video frame: ${frame.width}x${frame.height}`);
    });
    
    // Устанавливаем callback для аудио
    captureModule.setAudioCallback((audio) => {
        console.log(`Audio samples: ${audio.samples}`);
    });
    
    // Начинаем захват
    captureModule.startCapture();
    
    // Останавливаем через 5 секунд
    setTimeout(() => {
        captureModule.stopCapture();
        console.log('Capture stopped');
    }, 5000);
}