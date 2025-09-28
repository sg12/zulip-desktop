// video-quality-manager.ts - Модуль управления качеством видео для Jitsi
import log from "electron-log";

// ===== ОПРЕДЕЛЕНИЕ ПРЕСЕТОВ КАЧЕСТВА ВИДЕО =====
export interface VideoQualityPreset {
    name: string;
    description: string;
    width: { min: number; max: number };
    height: { min: number; max: number };
    frameRate: { min: number; max: number };
    bitrate?: number;
}

export const VIDEO_QUALITY_PRESETS: { [key: string]: VideoQualityPreset } = {
    ULTRALOW: {
        name: 'Ultra Low',
        description: '360p @ 10fps - минимальный трафик',
        width: { min: 360, max: 400 },
        height: { min: 240, max: 260 },
        frameRate: { min: 1, max: 3 },
        bitrate: 200000
    },
    LOW: {
        name: 'Low',
        description: '480p @ 15fps - экономия трафика',
        width: { min: 640, max: 854 },
        height: { min: 480, max: 480 },
        frameRate: { min: 10, max: 15 },
        bitrate: 500000
    },
    MEDIUM: {
        name: 'Medium',
        description: '720p @ 20fps - баланс качества и трафика',
        width: { min: 1024, max: 1280 },
        height: { min: 576, max: 720 },
        frameRate: { min: 15, max: 20 },
        bitrate: 1000000
    },
    HIGH: {
        name: 'High',
        description: '1080p @ 30fps - высокое качество',
        width: { min: 1280, max: 1920 },
        height: { min: 720, max: 1080 },
        frameRate: { min: 15, max: 30 },
        bitrate: 2500000
    },
    ULTRA: {
        name: 'Ultra',
        description: '1080p @ 60fps - максимальное качество',
        width: { min: 1920, max: 1920 },
        height: { min: 1080, max: 1080 },
        frameRate: { min: 30, max: 60 },
        bitrate: 4000000
    },
    ULTRA_HD: {
        name: '4K',
        description: '4K @ 30fps - ультра высокое разрешение',
        width: { min: 2560, max: 3840 },
        height: { min: 1440, max: 2160 },
        frameRate: { min: 15, max: 30 },
        bitrate: 8000000
    },
    PRESENTATION: {
        name: 'Presentation',
        description: '1080p @ 5fps - для слайдов',
        width: { min: 1920, max: 1920 },
        height: { min: 1080, max: 1080 },
        frameRate: { min: 3, max: 5 },
        bitrate: 1000000
    }
};

// ===== КЛАСС УПРАВЛЕНИЯ КАЧЕСТВОМ =====
export class VideoQualityManager {
    private currentPreset: string = 'HIGH';
    private customSettings: VideoQualityPreset | null = null;
    
    constructor() {
        log.info("[VIDEO-QUALITY] Manager initialized with HIGH preset");
    }
    
    setPreset(presetName: keyof typeof VIDEO_QUALITY_PRESETS): VideoQualityPreset {
        if (!VIDEO_QUALITY_PRESETS[presetName]) {
            log.error(`[VIDEO-QUALITY] Unknown preset: ${presetName}`);
            return VIDEO_QUALITY_PRESETS.HIGH;
        }
        
        this.currentPreset = presetName;
        this.customSettings = null;
        
        const preset = VIDEO_QUALITY_PRESETS[presetName];
        log.info(`[VIDEO-QUALITY] Set preset: ${preset.name} - ${preset.description}`);
        
        return preset;
    }
    
    setCustomQuality(settings: Partial<VideoQualityPreset>): VideoQualityPreset {
        this.customSettings = {
            name: 'Custom',
            description: 'User defined settings',
            width: settings.width || { min: 1280, max: 1920 },
            height: settings.height || { min: 720, max: 1080 },
            frameRate: settings.frameRate || { min: 15, max: 30 },
            bitrate: settings.bitrate
        };
        
        log.info(`[VIDEO-QUALITY] Set custom: ${this.customSettings.width.max}x${this.customSettings.height.max}@${this.customSettings.frameRate.max}fps`);
        
        return this.customSettings;
    }
    
    getCurrentSettings(): VideoQualityPreset {
        if (this.customSettings) {
            return this.customSettings;
        }
        return VIDEO_QUALITY_PRESETS[this.currentPreset];
    }
    
    getMediaConstraints(): any {
        const settings = this.getCurrentSettings();
        
        return {
            mandatory: {
                chromeMediaSource: 'desktop',
                minWidth: settings.width.min,
                maxWidth: settings.width.max,
                minHeight: settings.height.min,
                maxHeight: settings.height.max,
                minFrameRate: settings.frameRate.min,
                maxFrameRate: settings.frameRate.max
            }
        };
    }
}

// ===== ФУНКЦИИ ДЛЯ ПРИМЕНЕНИЯ КАЧЕСТВА В JITSI ОКНЕ =====

/**
 * Применяет пресет качества к активному видео потоку
 * Этот код выполняется в контексте Jitsi окна через executeJavaScript
 */
export function getApplyQualityPresetCode(preset: VideoQualityPreset, presetName: string): string {
    return `
        (async function() {
            try {
                if (!window.electronVideoStream && !window.jitsiNativeMediaStream) {
                    throw new Error('No video stream available');
                }
                
                const stream = window.electronVideoStream || window.jitsiNativeMediaStream;
                const videoTrack = stream.getVideoTracks()[0];
                
                if (!videoTrack) {
                    throw new Error('No video track found');
                }
                
                await videoTrack.applyConstraints({
                    width: { min: ${preset.width.min}, ideal: ${preset.width.max}, max: ${preset.width.max} },
                    height: { min: ${preset.height.min}, ideal: ${preset.height.max}, max: ${preset.height.max} },
                    frameRate: { min: ${preset.frameRate.min}, ideal: ${preset.frameRate.max}, max: ${preset.frameRate.max} }
                });
                
                const newSettings = videoTrack.getSettings();
                
                const display = document.getElementById('current-quality');
                if (display) {
                    display.textContent = \`Текущее: \${newSettings.width}x\${newSettings.height} @ \${Math.round(newSettings.frameRate)}fps\`;
                }
                
                const selector = document.getElementById('quality-preset');
                if (selector && selector.value !== 'CUSTOM') {
                    selector.value = '${presetName}';
                }
                
                return {
                    success: true,
                    quality: newSettings.width + 'x' + newSettings.height + '@' + Math.round(newSettings.frameRate) + 'fps',
                    actualSettings: newSettings
                };
                
            } catch (error) {
                console.error('[VIDEO-QUALITY] Error:', error);
                return { success: false, error: error.message };
            }
        })();
    `;
}

/**
 * Применяет кастомные настройки качества к активному видео потоку
 */
export function getApplyCustomQualityCode(width: number, height: number, fps: number): string {
    return `
        (async function() {
            try {
                if (!window.electronVideoStream && !window.jitsiNativeMediaStream) {
                    throw new Error('No video stream available');
                }
                
                const stream = window.electronVideoStream || window.jitsiNativeMediaStream;
                const videoTrack = stream.getVideoTracks()[0];
                
                if (!videoTrack) {
                    throw new Error('No video track found');
                }
                
                await videoTrack.applyConstraints({
                    width: { min: ${Math.floor(width * 0.8)}, ideal: ${width}, max: ${width} },
                    height: { min: ${Math.floor(height * 0.8)}, ideal: ${height}, max: ${height} },
                    frameRate: { min: ${Math.max(1, fps - 5)}, ideal: ${fps}, max: ${fps} }
                });
                
                const newSettings = videoTrack.getSettings();
                
                const display = document.getElementById('current-quality');
                if (display) {
                    display.textContent = \`Текущее: \${newSettings.width}x\${newSettings.height} @ \${Math.round(newSettings.frameRate)}fps\`;
                }
                
                const selector = document.getElementById('quality-preset');
                if (selector) {
                    selector.value = 'CUSTOM';
                }
                
                return {
                    success: true,
                    quality: newSettings.width + 'x' + newSettings.height + '@' + Math.round(newSettings.frameRate) + 'fps',
                    actualSettings: newSettings
                };
                
            } catch (error) {
                console.error('[VIDEO-QUALITY] Custom settings error:', error);
                return { success: false, error: error.message };
            }
        })();
    `;
}