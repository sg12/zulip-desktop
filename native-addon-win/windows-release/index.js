// Windows Screen Capture Module Wrapper
const path = require('path');

let screenCapture;

try {
    // Пробуем загрузить нативный модуль
    screenCapture = require('./screen_capture_win.node');
    console.log('[ScreenCapture] Native module loaded successfully');
} catch (error) {
    console.error('[ScreenCapture] Failed to load native module:', error.message);
    throw error;
}

// Экспортируем класс с удобным API
class ScreenCapture {
    constructor() {
        this.native = new screenCapture.ScreenCaptureModule();
        this.isCapturing = false;
    }

    // Получить список доступных источников
    getSources() {
        try {
            const sources = this.native.getAvailableSources();
            console.log(`[ScreenCapture] Found ${sources.length} sources`);
            return sources;
        } catch (error) {
            console.error('[ScreenCapture] Error getting sources:', error);
            return [];
        }
    }

    // Выбрать источник для захвата
    selectSource(type, id) {
        console.log(`[ScreenCapture] Selecting source: ${type} - ${id}`);
        return this.native.setCaptureSource(type, id);
    }

    // Начать захват
    start() {
        if (this.isCapturing) {
            console.warn('[ScreenCapture] Already capturing');
            return false;
        }
        console.log('[ScreenCapture] Starting capture...');
        const result = this.native.startCapture();
        this.isCapturing = result;
        return result;
    }

    // Остановить захват
    stop() {
        if (!this.isCapturing) {
            console.warn('[ScreenCapture] Not capturing');
            return false;
        }
        console.log('[ScreenCapture] Stopping capture...');
        const result = this.native.stopCapture();
        this.isCapturing = !result;
        return result;
    }

    // Установить callback для видео
    onVideoFrame(callback) {
        this.native.setVideoCallback(callback);
    }

    // Установить callback для аудио
    onAudioFrame(callback) {
        this.native.setAudioCallback(callback);
    }

    // Получить статистику
    getStats() {
        return this.native.getFrameStats();
    }
}

module.exports = ScreenCapture;
