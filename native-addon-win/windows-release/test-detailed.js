// Детальный тест с логированием в файл и консоль
const fs = require('fs');
const path = require('path');

// Создаем лог файл
const logFile = path.join(__dirname, `test-log-${Date.now()}.txt`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

// Функция для логирования
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level,
        message,
        data
    };
    
    // В консоль
    const consoleMsg = `[${timestamp}] [${level}] ${message}`;
    if (level === 'ERROR') {
        console.error(consoleMsg, data || '');
    } else {
        console.log(consoleMsg, data || '');
    }
    
    // В файл
    logStream.write(JSON.stringify(logEntry) + '\n');
}

// Информация о системе
log('INFO', '=== SYSTEM INFO ===');
log('INFO', 'Platform:', process.platform);
log('INFO', 'Architecture:', process.arch);
log('INFO', 'Node version:', process.version);
log('INFO', 'Current directory:', __dirname);

// Проверяем наличие файла модуля
const modulePath = path.join(__dirname, 'screen_capture_win.node');
log('INFO', 'Module path:', modulePath);

if (fs.existsSync(modulePath)) {
    log('INFO', 'Module file exists');
    const stats = fs.statSync(modulePath);
    log('INFO', 'Module file size:', stats.size);
} else {
    log('ERROR', 'Module file NOT found!');
    process.exit(1);
}

// Пробуем загрузить модуль
log('INFO', '=== LOADING MODULE ===');
let screenCapture = null;

try {
    // Пробуем прямую загрузку .node файла
    log('INFO', 'Attempting to load native module...');
    screenCapture = require('./screen_capture_win.node');
    log('SUCCESS', 'Native module loaded!');
    log('INFO', 'Module exports:', Object.keys(screenCapture));
    
} catch (error) {
    log('ERROR', 'Failed to load native module');
    log('ERROR', 'Error message:', error.message);
    log('ERROR', 'Error stack:', error.stack);
    
    // Детальная информация об ошибке
    if (error.message.includes('MODULE_NOT_FOUND')) {
        log('ERROR', 'Module not found - check file path');
    } else if (error.message.includes('not a valid Win32 application')) {
        log('ERROR', 'Architecture mismatch - module is for different architecture');
    } else if (error.message.includes('specified module could not be found')) {
        log('ERROR', 'Missing dependencies - need Visual C++ Redistributables');
    }
    
    // Пробуем альтернативную загрузку
    log('INFO', 'Trying alternative load via index.js...');
    try {
        const ScreenCapture = require('./index.js');
        const capture = new ScreenCapture();
        log('SUCCESS', 'Loaded via wrapper!');
    } catch (error2) {
        log('ERROR', 'Alternative load also failed:', error2.message);
    }
    
    process.exit(1);
}

// Тестируем функциональность
log('INFO', '=== TESTING FUNCTIONALITY ===');

try {
    // Проверяем наличие класса
    if (screenCapture.ScreenCaptureModule) {
        log('INFO', 'ScreenCaptureModule class found');
        
        // Создаем экземпляр
        log('INFO', 'Creating instance...');
        const capture = new screenCapture.ScreenCaptureModule();
        log('SUCCESS', 'Instance created');
        
        // Тест 1: Получение источников
        log('INFO', 'Test 1: Getting available sources...');
        try {
            const sources = capture.getAvailableSources();
            log('SUCCESS', 'Got sources:', sources);
            
            if (Array.isArray(sources)) {
                log('INFO', `Found ${sources.length} sources`);
                sources.forEach((source, i) => {
                    log('INFO', `Source ${i}:`, {
                        type: source.type,
                        id: source.id,
                        name: source.name,
                        dimensions: `${source.width}x${source.height}`
                    });
                });
            }
        } catch (e) {
            log('ERROR', 'Failed to get sources:', e.message);
        }
        
        // Тест 2: Установка источника
        log('INFO', 'Test 2: Setting capture source...');
        try {
            const result = capture.setCaptureSource('display', '0');
            log('SUCCESS', 'Set capture source result:', result);
        } catch (e) {
            log('ERROR', 'Failed to set source:', e.message);
        }
        
        // Тест 3: Получение статистики
        log('INFO', 'Test 3: Getting frame stats...');
        try {
            const stats = capture.getFrameStats();
            log('SUCCESS', 'Frame stats:', stats);
        } catch (e) {
            log('ERROR', 'Failed to get stats:', e.message);
        }
        
        // Тест 4: Callbacks
        log('INFO', 'Test 4: Setting callbacks...');
        try {
            capture.setVideoCallback((frame) => {
                log('INFO', 'Video callback triggered:', {
                    width: frame.width,
                    height: frame.height,
                    dataSize: frame.data ? frame.data.byteLength : 0
                });
            });
            log('SUCCESS', 'Video callback set');
            
            capture.setAudioCallback((audio) => {
                log('INFO', 'Audio callback triggered:', audio);
            });
            log('SUCCESS', 'Audio callback set');
        } catch (e) {
            log('ERROR', 'Failed to set callbacks:', e.message);
        }
        
        // Тест 5: Запуск захвата
        log('INFO', 'Test 5: Starting capture...');
        try {
            const startResult = capture.startCapture();
            log('SUCCESS', 'Start capture result:', startResult);
            
            // Даем поработать 3 секунды
            setTimeout(() => {
                log('INFO', 'Stopping capture...');
                try {
                    const stopResult = capture.stopCapture();
                    log('SUCCESS', 'Stop capture result:', stopResult);
                } catch (e) {
                    log('ERROR', 'Failed to stop:', e.message);
                }
                
                // Завершаем
                log('INFO', '=== TEST COMPLETED ===');
                log('INFO', `Log saved to: ${logFile}`);
                logStream.end();
                process.exit(0);
            }, 3000);
            
        } catch (e) {
            log('ERROR', 'Failed to start capture:', e.message);
            process.exit(1);
        }
        
    } else {
        log('ERROR', 'ScreenCaptureModule class not found in exports');
        log('ERROR', 'Available exports:', Object.keys(screenCapture));
    }
    
} catch (error) {
    log('ERROR', 'Test failed with exception:', error.message);
    log('ERROR', 'Stack trace:', error.stack);
    process.exit(1);
}
