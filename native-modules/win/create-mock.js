const fs = require('fs');
const path = require('path');

// Создаем mock native модуль как обычный JavaScript модуль
const mockModule = `
// Mock Windows Native Module
const mockSources = [
    {
        id: '1',
        name: 'Display 1',
        type: 'screen',
        width: 1920,
        height: 1080
    },
    {
        id: '1001',
        name: 'Visual Studio Code',
        type: 'window',
        width: 1024,
        height: 768
    }
];

module.exports = {
    testMethod: function() {
        return 'Windows Mock Module v1.0';
    },
    
    getAvailableSources: async function() {
        // Симулируем асинхронность
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(mockSources);
            }, 100);
        });
    },
    
    setCaptureSource: function(type, id) {
        console.log(\`[WinMock] Set source: \${type}:\${id}\`);
        return { success: true };
    },
    
    setCaptureSourceById: function(typeNum, idNum) {
        console.log(\`[WinMock] Set source by ID: \${typeNum}:\${idNum}\`);
        return { success: true };
    },
    
    setCaptureQuality: function(width, height, fps) {
        console.log(\`[WinMock] Set quality: \${width}x\${height}@\${fps}\`);
        return { success: true };
    },
    
    startCapture: function() {
        console.log('[WinMock] Start capture');
        return { success: true };
    },
    
    stopCapture: function() {
        console.log('[WinMock] Stop capture');
        return { success: true };
    },
    
    setWebRTCVideoCallback: function(callback) {
        console.log('[WinMock] Video callback set');
        // Генерируем тестовые данные
        setInterval(() => {
            callback({
                data: new ArrayBuffer(1920 * 1080 * 4),
                width: 1920,
                height: 1080,
                timestamp: Date.now()
            });
        }, 100);
    },
    
    setWebRTCAudioCallback: function(callback) {
        console.log('[WinMock] Audio callback set');
        setInterval(() => {
            callback({
                data: new ArrayBuffer(960 * 2 * 4),
                sampleRate: 48000,
                channels: 2,
                numSamples: 960
            });
        }, 20);
    }
};
`;

// Создаем build директорию
const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
}

// Записываем файл
const outputPath = path.join(buildDir, 'screen_capture_win.node');
fs.writeFileSync(outputPath, mockModule);

console.log(`✅ Created mock module at: ${outputPath}`);
console.log(`📊 Module size: ${mockModule.length} bytes`);
