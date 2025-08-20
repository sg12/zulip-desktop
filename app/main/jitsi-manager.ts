// jitsi-manager.ts - Модуль для управления Jitsi окнами
import { BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import log from "electron-log";
import { NativeCaptureManager } from "./native-capture";
import { JitsiScreenShareMonitor } from "./jitsi-screen-share-monitor";

interface JitsiOptions {
  roomName: string;
  serverUrl?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  jwt?: string;
}

interface JitsiState {
  window: BrowserWindow | null;
  isStreamActive: boolean;
  streamId: string | null;
  lastSelectedSourceId?: string;
  videoFrameCount?: number; 
  audioFrameCount?: number;
  qualityPreset?: string;
}

// ===== ОПРЕДЕЛЕНИЕ ПРЕСЕТОВ КАЧЕСТВА ВИДЕО =====
export interface VideoQualityPreset {
    name: string;
    description: string;
    width: { min: number; max: number };
    height: { min: number; max: number };
    frameRate: { min: number; max: number };
    bitrate?: number; // опционально для WebRTC
}

// ===== КЛАСС УПРАВЛЕНИЯ КАЧЕСТВОМ =====
export class VideoQualityManager {
    private currentPreset: string = 'HIGH';
    private customSettings: VideoQualityPreset | null = null;
    
    constructor() {
        log.info("[VIDEO-QUALITY] Manager initialized with HIGH preset");
    }
    
    // Установить пресет качества
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
    
    // Установить кастомные настройки
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
    
    // Получить текущие настройки
    getCurrentSettings(): VideoQualityPreset {
        if (this.customSettings) {
            return this.customSettings;
        }
        return VIDEO_QUALITY_PRESETS[this.currentPreset];
    }
    
    // Сформировать constraints для getUserMedia
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
    
    // Адаптивная настройка по пропускной способности
    async adaptQualityToBandwidth(availableBandwidth: number): Promise<VideoQualityPreset> {
        log.info(`[VIDEO-QUALITY] Adapting to bandwidth: ${(availableBandwidth / 1000000).toFixed(2)} Mbps`);
        
        // Выбираем подходящий пресет по битрейту
        if (availableBandwidth < 300000) {
            return this.setPreset('ULTRA_LOW');
        } else if (availableBandwidth < 700000) {
            return this.setPreset('LOW');
        } else if (availableBandwidth < 1500000) {
            return this.setPreset('MEDIUM');
        } else if (availableBandwidth < 3000000) {
            return this.setPreset('HIGH');
        } else if (availableBandwidth < 5000000) {
            return this.setPreset('ULTRA');
        } else {
            return this.setPreset('ULTRA_HD');
        }
    }
    
    // Мониторинг реального качества
    analyzeActualQuality(videoTrack: MediaStreamTrack): {
        preset: string;
        actual: { width: number; height: number; frameRate: number };
        match: boolean;
    } {
        const settings = videoTrack.getSettings();
        const current = this.getCurrentSettings();
        
        const actualQuality = {
            width: settings.width || 0,
            height: settings.height || 0,
            frameRate: settings.frameRate || 0
        };
        
        // Проверяем соответствие
        const match = 
            actualQuality.width >= current.width.min &&
            actualQuality.width <= current.width.max &&
            actualQuality.height >= current.height.min &&
            actualQuality.height <= current.height.max &&
            actualQuality.frameRate >= current.frameRate.min &&
            actualQuality.frameRate <= current.frameRate.max;
        
        log.info(`[VIDEO-QUALITY] Actual: ${actualQuality.width}x${actualQuality.height}@${actualQuality.frameRate}fps`);
        log.info(`[VIDEO-QUALITY] Match preset: ${match ? 'YES' : 'NO'}`);
        
        return {
            preset: this.customSettings ? 'Custom' : this.currentPreset,
            actual: actualQuality,
            match
        };
    }
}

export const VIDEO_QUALITY_PRESETS: { [key: string]: VideoQualityPreset } = {
    // Ультра низкое - для экономии трафика
    ULTRA_LOW: {
        name: 'Ultra Low',
        description: '360p @ 10fps - минимальный трафик',
        width: { min: 100, max: 144 },
        height: { min: 100, max: 160 },
        frameRate: { min: 1, max: 3 },
        bitrate: 200000 // 200 kbps
    },
    
    // Низкое - базовое качество
    LOW: {
        name: 'Low',
        description: '480p @ 15fps - экономия трафика',
        width: { min: 640, max: 854 },
        height: { min: 480, max: 480 },
        frameRate: { min: 10, max: 15 },
        bitrate: 500000 // 500 kbps
    },
    
    // Среднее - оптимальный баланс
    MEDIUM: {
        name: 'Medium',
        description: '720p @ 20fps - баланс качества и трафика',
        width: { min: 1024, max: 1280 },
        height: { min: 576, max: 720 },
        frameRate: { min: 15, max: 20 },
        bitrate: 1000000 // 1 Mbps
    },
    
    // Высокое - для презентаций
    HIGH: {
        name: 'High',
        description: '1080p @ 30fps - высокое качество',
        width: { min: 1280, max: 1920 },
        height: { min: 720, max: 1080 },
        frameRate: { min: 15, max: 30 },
        bitrate: 2500000 // 2.5 Mbps
    },
    
    // Ультра - максимальное качество
    ULTRA: {
        name: 'Ultra',
        description: '1080p @ 60fps - максимальное качество',
        width: { min: 1920, max: 1920 },
        height: { min: 1080, max: 1080 },
        frameRate: { min: 30, max: 60 },
        bitrate: 4000000 // 4 Mbps
    },
    
    // 4K - для специальных случаев
    ULTRA_HD: {
        name: '4K',
        description: '4K @ 30fps - ультра высокое разрешение',
        width: { min: 2560, max: 3840 },
        height: { min: 1440, max: 2160 },
        frameRate: { min: 15, max: 30 },
        bitrate: 8000000 // 8 Mbps
    },
    
    // Презентация - оптимизировано для статичного контента
    PRESENTATION: {
        name: 'Presentation',
        description: '1080p @ 5fps - для слайдов',
        width: { min: 1920, max: 1920 },
        height: { min: 1080, max: 1080 },
        frameRate: { min: 3, max: 5 },
        bitrate: 1000000 // 1 Mbps
    },
    
    // Адаптивное - подстраивается под сеть
    ADAPTIVE: {
        name: 'Adaptive',
        description: 'Автоматическая настройка',
        width: { min: 640, max: 1920 },
        height: { min: 480, max: 1080 },
        frameRate: { min: 10, max: 30 },
        bitrate: 0 // Автоматически
    }
};

export interface JitsiManagerConfig {
    videoQuality?: keyof typeof VIDEO_QUALITY_PRESETS;
    audioQuality?: keyof typeof CAPTURE_PRESETS;
    useHybridMode?: boolean; // true = Electron video + Native audio, false = все от Native
    enableDebugUI?: boolean;
    enablePerformanceMonitoring?: boolean;
    monitoringInterval?: number; // ms
}

// Настройки по умолчанию
const DEFAULT_CONFIG: JitsiManagerConfig = {
    videoQuality: 'MEDIUM',
    audioQuality: 'ULTRALOW', // для Native (не используется в hybrid mode)
    useHybridMode: true,
    enableDebugUI: true,
    enablePerformanceMonitoring: false,
    monitoringInterval: 5000
};

export class JitsiManager {
    private state: JitsiState = {
        window: null,
        isStreamActive: false,
        streamId: null
    };

    private nativeCapture: NativeCaptureManager;
    private bundlePath: string;
    private iconPath: string;
    private config: JitsiManagerConfig;
    private videoQualityManager: VideoQualityManager;
    private performanceMonitoringInterval?: NodeJS.Timer;

    private screenShareMonitor: JitsiScreenShareMonitor;
    private activeMediaStreams: Set<string> = new Set(); 
    private debugMonitoringStarted: boolean = false;
    private debugMonitoringInterval?: NodeJS.Timer;

    // Добавьте отслеживание последней метки видео:
    private lastVideoTimestamp: number = 0;

    private getLastVideoTimestamp(): number {
        return this.lastVideoTimestamp;
    }

    constructor(
        nativeCapture: NativeCaptureManager,
        bundlePath: string,
        iconPath: string,
        config?: Partial<JitsiManagerConfig> // Опциональные настройки
    ) {
        this.nativeCapture = nativeCapture;
        this.bundlePath = bundlePath;
        this.iconPath = iconPath;
        
        // Мержим дефолтные настройки с переданными
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Инициализируем менеджер качества с настройками
        this.videoQualityManager = new VideoQualityManager();
        if (this.config.videoQuality) {
            this.videoQualityManager.setPreset(this.config.videoQuality);
        }
        
        log.info("[JITSI-MANAGER] Initialized with config:", this.config);
        
        this.registerHandlers();

        this.screenShareMonitor = new JitsiScreenShareMonitor();

        if (this.config.enableDebugUI === undefined) {
            this.config.enableDebugUI = process.env.NODE_ENV === 'development' || 
                                    process.argv.includes('--debug-ui');
        }
        
         this.debugMonitoringStarted = false;

        log.info("[JITSI-MANAGER] Debug UI enabled:", this.config.enableDebugUI);
    }

    private isWindowsPlatform(): boolean {
        return process.platform === 'win32';
    }

    // В jitsi-manager.ts, обновите метод injectDebugOverlay()
    private async injectDebugOverlay(): Promise<void> {
        log.info("[JITSI-MANAGER] ============ DEBUG OVERLAY INJECTION START ============");
        log.info("[JITSI-MANAGER] Config enableDebugUI:", this.config.enableDebugUI);
        log.info("[JITSI-MANAGER] Window exists:", !!this.state.window);
        log.info("[JITSI-MANAGER] Window destroyed:", this.state.window?.isDestroyed());
        
        if (!this.config.enableDebugUI) {
            log.warn("[JITSI-MANAGER] Debug UI is disabled in config");
            return;
        }
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[JITSI-MANAGER] No window available for debug overlay");
            return;
        }
        
        try {
            // Проверяем наличие панели
            const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
                !!(document.getElementById('native-debug-overlay'))
            `);
            
            log.info("[JITSI-MANAGER] Already injected:", alreadyInjected);
            
            if (alreadyInjected) {
                log.info("[JITSI-MANAGER] Debug overlay already exists");
                return;
            }
            
            // Пробуем инъектировать основную панель
            log.info("[JITSI-MANAGER] Injecting main debug overlay...");
            
            const result = await this.state.window.webContents.executeJavaScript(`
                (function() {
                    try {
                        console.log('[INJECTION] Starting main overlay injection...');
                        
                        // Проверяем, что можем создавать элементы
                        const testDiv = document.createElement('div');
                        if (!testDiv) {
                            throw new Error('Cannot create elements');
                        }
                        
                        // Удаляем старые панели
                        const oldOverlay = document.getElementById('native-debug-overlay');
                        if (oldOverlay) oldOverlay.remove();
                        
                        const oldSimple = document.getElementById('simple-debug');
                        if (oldSimple) oldSimple.remove();
                        
                        // Создаем панель пошагово
                        const overlay = document.createElement('div');
                        overlay.id = 'native-debug-overlay';
                        
                        // Устанавливаем стили по одному
                        overlay.style.position = 'fixed';
                        overlay.style.top = '20px';
                        overlay.style.right = '20px';
                        overlay.style.width = '350px';
                        overlay.style.background = 'rgba(0, 0, 0, 0.9)';
                        overlay.style.color = 'white';
                        overlay.style.fontFamily = 'monospace';
                        overlay.style.fontSize = '12px';
                        overlay.style.padding = '15px';
                        overlay.style.borderRadius = '10px';
                        overlay.style.zIndex = '999999';
                        overlay.style.border = '2px solid #333';
                        
                        // Простой HTML для теста
                        overlay.innerHTML = '<div style="color: #4CAF50; font-size: 16px; font-weight: bold;">🔧 Native Debug Panel v2</div>' +
                            '<div style="margin-top: 10px;">' +
                            '<div id="plugin-status" style="margin: 5px 0;">Plugin: Checking...</div>' +
                            '<div id="capture-status" style="margin: 5px 0;">Capture: Not active</div>' +
                            '<div id="audio-packets" style="margin: 5px 0;">Audio: 0 packets</div>' +
                            '<div id="video-packets" style="margin: 5px 0;">Video: 0 packets</div>' +
                            '</div>' +
                            '<button id="debug-close" style="position: absolute; top: 5px; right: 5px; background: red; color: white; border: none; padding: 2px 6px; cursor: pointer;">X</button>';
                        
                        // Добавляем в DOM
                        document.body.appendChild(overlay);
                        console.log('[INJECTION] Overlay added to DOM');
                        
                        // Добавляем обработчик закрытия
                        const closeBtn = document.getElementById('debug-close');
                        if (closeBtn) {
                            closeBtn.onclick = function() {
                                overlay.remove();
                            };
                        }
                        
                        // Создаем глобальную функцию обновления
                        window.updateDebugStatus = function(data) {
                            console.log('[INJECTION] Updating debug status:', data);
                            
                            const pluginEl = document.getElementById('plugin-status');
                            if (pluginEl && data.hasAddon !== undefined) {
                                pluginEl.textContent = 'Plugin: ' + (data.hasAddon ? '✅ Loaded' : '❌ Not loaded');
                            }
                            
                            const captureEl = document.getElementById('capture-status');
                            if (captureEl && data.nativeCaptureActive !== undefined) {
                                captureEl.textContent = 'Capture: ' + (data.nativeCaptureActive ? '✅ Active' : '❌ Inactive');
                            }
                            
                            const audioEl = document.getElementById('audio-packets');
                            if (audioEl && data.audioFrameCount !== undefined) {
                                audioEl.textContent = 'Audio: ' + data.audioFrameCount + ' packets';
                            }
                            
                            const videoEl = document.getElementById('video-packets');
                            if (videoEl && data.videoFrameCount !== undefined) {
                                videoEl.textContent = 'Video: ' + data.videoFrameCount + ' packets';
                            }
                        };
                        
                        console.log('[INJECTION] ✅ Main overlay injected successfully');
                        return { success: true, type: 'main' };
                        
                    } catch (error) {
                        console.error('[INJECTION] Main overlay failed:', error.message);
                        return { success: false, error: error.message };
                    }
                })();
            `);
            
            log.info("[JITSI-MANAGER] Injection result:", JSON.stringify(result));
            
            if (result && result.success) {
                log.info("✅ Main debug overlay injected successfully");
                
                // Сразу отправляем начальные данные
                const debugInfo = await this.getDebugInfo();
                await this.state.window.webContents.executeJavaScript(`
                    if (window.updateDebugStatus) {
                        window.updateDebugStatus(${JSON.stringify(debugInfo)});
                    }
                `);
                
                // Запускаем мониторинг
                this.startDebugMonitoring();
                
            } else {
                log.error("Main overlay failed, trying simple fallback...");
                log.error("Error was:", result?.error);
                
                // Fallback на простую версию
                await this.injectSimpleDebugOverlay();
            }
            
        } catch (error: any) {
            log.error(`[JITSI-MANAGER] Exception during injection: ${error.message}`);
            log.error("Full error:", error);
            
            // Fallback
            await this.injectSimpleDebugOverlay();
        }
        
        log.info("[JITSI-MANAGER] ============ DEBUG OVERLAY INJECTION END ============");
    }

    private async injectSimpleDebugOverlay(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    // Удаляем старую панель если есть
                    const existing = document.getElementById('simple-debug');
                    if (existing) existing.remove();
                    
                    // Создаем простую панель
                    const panel = document.createElement('div');
                    panel.id = 'simple-debug';
                    panel.style.cssText = \`
                        position: fixed;
                        top: 10px;
                        right: 10px;
                        background: rgba(255, 0, 0, 0.9);
                        color: white;
                        padding: 10px;
                        z-index: 999999;
                        font-family: monospace;
                        font-size: 12px;
                        border-radius: 5px;
                    \`;
                    panel.innerHTML = '🔧 DEBUG PANEL ACTIVE';
                    document.body.appendChild(panel);
                    
                    console.log('✅ Simple debug panel injected');
                    return true;
                })();
            `);
            
            log.info("Simple debug overlay injected as fallback");
        } catch (error: any) {
            log.error(`Simple overlay injection failed: ${error.message}`);
        }
    }

    // 🆕 НОВЫЙ МЕТОД - мониторинг статуса
    private startDebugMonitoring(): void {
        if (!this.config.enableDebugUI || this.debugMonitoringInterval) return;
        
        log.info("[JITSI-MANAGER] Starting debug monitoring...");
        
        const updateInterval = 1000; // Обновляем каждую секунду
        
        this.debugMonitoringInterval = setInterval(async () => {
            if (!this.state.window || this.state.window.isDestroyed()) {
                clearInterval(this.debugMonitoringInterval);
                this.debugMonitoringInterval = undefined;
                return;
            }
            
            try {
                const debugInfo = await this.getDebugInfo();
                
                // Добавляем счетчики из state
                debugInfo.audioFrameCount = this.state.audioFrameCount || 0;
                debugInfo.videoFrameCount = this.state.videoFrameCount || 0;
                
                await this.state.window.webContents.executeJavaScript(`
                    if (window.updateDebugStatus) {
                        window.updateDebugStatus(${JSON.stringify(debugInfo)});
                    }
                `);
                
            } catch (error) {
                // Тихо игнорируем ошибки мониторинга
            }
        }, updateInterval);
    }

    // Метод для обновления настроек на лету
    updateConfig(newConfig: Partial<JitsiManagerConfig>): void {
        log.info("[JITSI-MANAGER] Updating config:", newConfig);
        
        const oldConfig = { ...this.config };
        this.config = { ...this.config, ...newConfig };
        
        // Применяем изменения
        if (newConfig.videoQuality && newConfig.videoQuality !== oldConfig.videoQuality) {
            this.videoQualityManager.setPreset(newConfig.videoQuality);
            
            // Если stream активен, применяем изменения сразу
            if (this.state.isStreamActive) {
                this.changeVideoQuality(newConfig.videoQuality).catch(err => {
                    log.error("[JITSI-MANAGER] Failed to apply video quality:", err);
                });
            }
        }
        
        // Обновляем мониторинг
        if (newConfig.enablePerformanceMonitoring !== undefined) {
            if (newConfig.enablePerformanceMonitoring && !this.performanceMonitoringInterval) {
                this.startPerformanceMonitoring();
            } else if (!newConfig.enablePerformanceMonitoring && this.performanceMonitoringInterval) {
                this.stopPerformanceMonitoring();
            }
        }
    }

    // Геттер для получения текущих настроек
    getConfig(): JitsiManagerConfig {
        return { ...this.config };
    }

    private registerHandlers(): void {

        // Основной обработчик для создания окна
        ipcMain.handle("jitsi:create-window", async (event, options: JitsiOptions) => {
            return this.createWindow(options);
        });

        // Создание и инъекция native stream
        ipcMain.handle("jitsi:inject-native-stream", async () => {
            return this.injectNativeStream();
        });

        // Закрытие окна
        ipcMain.handle("jitsi:close", async () => {
            return this.closeWindow();
        });

        // Получение статуса
        ipcMain.handle("jitsi:get-status", async () => {
        return {
            hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
            isStreamActive: this.state.isStreamActive,
            streamId: this.state.streamId
        };
        });

        ipcMain.handle("jitsi:save-selected-source", async (event, sourceId: string) => {
            this.state.lastSelectedSourceId = sourceId;
            log.info(`Saved selected source: ${sourceId}`);
            return { success: true };
        });

        ipcMain.handle("get-electron-desktop-sources", async () => {
            const { desktopCapturer } = require('electron');
            const sources = await desktopCapturer.getSources({
                types: ['window', 'screen'],
                thumbnailSize: { width: 150, height: 150 }
            });
            
            return sources.map(s => ({
                id: s.id,
                name: s.name,
                display_id: s.display_id
            }));
        });

        ipcMain.handle("jitsi:get-config", async () => {
            return this.getConfig();
        });

        ipcMain.handle("jitsi:update-config", async (event, newConfig: Partial<JitsiManagerConfig>) => {
            try {
                this.updateConfig(newConfig);
                return { success: true, config: this.getConfig() };
            } catch (error: any) {
                log.error("[JITSI-MANAGER] Failed to update config:", error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle("jitsi:get-quality-presets", async () => {
            return {
                video: Object.entries(VIDEO_QUALITY_PRESETS).map(([key, preset]) => ({
                    key,
                    name: preset.name,
                    description: preset.description,
                    resolution: `${preset.width.max}x${preset.height.max}`,
                    fps: preset.frameRate.max
                })),
                audio: Object.entries(CAPTURE_PRESETS).map(([key, preset]) => ({
                    key,
                    name: preset.name,
                    description: preset.description
                }))
            };
        });

        ipcMain.handle("jitsi:change-video-quality", async (event, quality: keyof typeof VIDEO_QUALITY_PRESETS) => {
            return this.changeVideoQuality(quality);
        });

        // Установить режим (hybrid или native)
        ipcMain.handle("jitsi:set-stream-mode", async (event, useHybrid: boolean) => {
            this.updateConfig({ useHybridMode: useHybrid });
            
            // Если stream активен, нужно его пересоздать
            if (this.state.isStreamActive) {
                log.info("[JITSI-MANAGER] Recreating stream with new mode...");
                // Логика пересоздания потока
            }
            
            return { success: true, mode: useHybrid ? 'hybrid' : 'native' };
        });

        ipcMain.handle("jitsi:get-debug-info", async () => {
            const debugInfo = {
                hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
                isStreamActive: this.state.isStreamActive,
                streamId: this.state.streamId,
                nativeCaptureActive: this.nativeCapture.isCapturing,
                videoFrameCount: this.state.videoFrameCount,
                audioFrameCount: this.state.audioFrameCount,
                lastSelectedSource: this.state.lastSelectedSourceId,
                currentQuality: this.videoQualityManager.getCurrentSettings().name
            };
            
            log.info("[STREAM-ELECTRON] Debug info:", debugInfo);
            return debugInfo;
        });

        ipcMain.handle("jitsi:force-reset", async () => {
            log.info("[STREAM-ELECTRON] Force reset requested");
            await this.resetManager();
            return { success: true };
        });

        ipcMain.handle("create-native-stream-for-jitsi", async () => {
            log.info("[STREAM-ELECTRON] Create native stream requested");
            
            try {
                // Проверяем состояние
                if (this.state.isStreamActive) {
                    log.warn("[STREAM-ELECTRON] Stream already active, resetting...");
                    await this.cleanup();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                return await this.injectNativeStream();
                
            } catch (error: any) {
                log.error("[STREAM-ELECTRON] Error creating native stream:", error);
                return { success: false, error: error.message };
            }
        });


        ipcMain.handle("jitsi:conference-left", async () => {
            log.info("[JITSI-MANAGER] Conference left event received");
            
            // Небольшая задержка для корректного завершения
            setTimeout(async () => {
                log.info("[JITSI-MANAGER] Closing window after conference leave");
                await this.closeWindow();
            }, 1000);
            
            return { success: true };
        });

        ipcMain.handle("jitsi:stop-native-capture", async () => {
            log.info("[STREAM-ELECTRON] Stop native capture requested");
            
            try {
                // Полная очистка всех потоков
                await this.nukeClearAllStreams();
                
                // Остановка native capture
                if (this.nativeCapture && this.nativeCapture.isCapturing) {
                    const stopResult = await this.nativeCapture.stopCapture();
                    log.info(`[STREAM-ELECTRON] Native capture stopped: ${JSON.stringify(stopResult)}`);
                }
                
                // Принудительное освобождение ресурсов
                await this.forceReleaseAllMediaResources();
                
                // Сброс состояния
                this.state.isStreamActive = false;
                this.state.streamId = null;
                this.state.videoFrameCount = 0;
                this.state.audioFrameCount = 0;
                
                this.nativeCapture.setFrameCallbacks(undefined, undefined);
                this.activeMediaStreams.clear();
                
                return { success: true };
                
            } catch (error: any) {
                log.error(`[STREAM-ELECTRON] Error stopping: ${error.message}`);
                return { success: false, error: error.message };
            }
        });

    }

    async getDebugInfo(): Promise<any> {
        // 🆕 Получаем информацию о здоровье плагина
        const addonHealth = await this.nativeCapture.testAddonHealth();
        
        const debugInfo = {
            hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
            isStreamActive: this.state.isStreamActive,
            streamId: this.state.streamId,
            nativeCaptureActive: this.nativeCapture.isCapturing,
            videoFrameCount: this.state.videoFrameCount || 0,
            audioFrameCount: this.state.audioFrameCount || 0,
            lastSelectedSource: this.state.lastSelectedSourceId,
            currentQuality: this.videoQualityManager?.getCurrentSettings()?.name || 'unknown',
            useHybridMode: this.config.useHybridMode,
            timestamp: new Date().toISOString(),
            
            // 🆕 Информация о плагине
            hasAddon: this.nativeCapture.isAvailable,
            addonType: addonHealth.addonType,
            addonHealthy: addonHealth.healthy,
            addonDetails: addonHealth.details
        };
        
        log.info("[STREAM-ELECTRON] Debug info:", debugInfo);
        return debugInfo;
    }

    private async nukeClearAllStreams(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[NUKE] === NUCLEAR CLEANUP STARTING ===');
                    
                    // Временно блокируем getUserMedia
                    const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
                    navigator.mediaDevices.getUserMedia = function() {
                        throw new Error('getUserMedia blocked during cleanup');
                    };
                    
                    try {
                        // Находим ВСЕ MediaStream объекты
                        const allStreams = [];
                        
                        // Через глобальный трекер
                        if (window.__allMediaStreams) {
                            window.__allMediaStreams.forEach(stream => {
                                allStreams.push(stream);
                            });
                            window.__allMediaStreams.clear();
                        }
                        
                        // Через глобальные переменные
                        for (let key in window) {
                            try {
                                if (window[key] instanceof MediaStream) {
                                    allStreams.push(window[key]);
                                    window[key] = null;
                                }
                            } catch(e) {}
                        }
                        
                        // Через video/audio элементы
                        [...document.querySelectorAll('video'), ...document.querySelectorAll('audio')].forEach(el => {
                            if (el.srcObject instanceof MediaStream) {
                                allStreams.push(el.srcObject);
                                el.srcObject = null;
                            }
                        });
                        
                        // Останавливаем ВСЕ треки
                        allStreams.forEach(stream => {
                            stream.getTracks().forEach(track => {
                                if (track.readyState === 'live') {
                                    track.stop();
                                    console.log('[NUKE] Stopped track:', track.id, track.kind);
                                }
                            });
                        });
                        
                        // Очищаем Jitsi треки
                        if (window.APP?.conference) {
                            const tracks = window.APP.conference.getLocalTracks?.() || [];
                            tracks.forEach(t => {
                                if (t.dispose) t.dispose();
                            });
                            
                            if (window.APP.conference._localTracks) {
                                window.APP.conference._localTracks = [];
                            }
                            if (window.APP.conference.localDesktop) {
                                window.APP.conference.localDesktop = null;
                            }
                        }
                        
                    } finally {
                        // Восстанавливаем getUserMedia
                        setTimeout(() => {
                            navigator.mediaDevices.getUserMedia = originalGetUserMedia;
                        }, 100);
                    }
                    
                    console.log('[NUKE] === NUCLEAR CLEANUP COMPLETED ===');
                })();
            `);
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Nuke clear error: ${error.message}`);
        }
    }

    // Метод для изменения качества видео
    async changeVideoQuality(presetName: keyof typeof VIDEO_QUALITY_PRESETS): Promise<{ success: boolean; quality?: string }> {
            log.info(`[STREAM-ELECTRON] Changing video quality to: ${presetName}`);
            
            if (!this.state.window || this.state.window.isDestroyed()) {
                return { success: false };
            }
            
            try {
                // Устанавливаем новый пресет
                const preset = this.videoQualityManager.setPreset(presetName);
                
                // Применяем к существующему потоку
                const result = await this.state.window.webContents.executeJavaScript(`
                    (async function() {
                        try {
                            if (!window.electronVideoStream) {
                                throw new Error('No video stream');
                            }
                            
                            const videoTrack = window.electronVideoStream.getVideoTracks()[0];
                            if (!videoTrack) {
                                throw new Error('No video track');
                            }
                            
                            // Применяем новые constraints
                            await videoTrack.applyConstraints({
                                width: { min: ${preset.width.min}, ideal: ${preset.width.max}, max: ${preset.width.max} },
                                height: { min: ${preset.height.min}, ideal: ${preset.height.max}, max: ${preset.height.max} },
                                frameRate: { min: ${preset.frameRate.min}, ideal: ${preset.frameRate.max}, max: ${preset.frameRate.max} }
                            });
                            
                            const newSettings = videoTrack.getSettings();
                            console.log('[VIDEO-QUALITY] Applied:', newSettings.width + 'x' + newSettings.height + '@' + newSettings.frameRate + 'fps');
                            
                            
                            return {
                                success: true,
                                quality: newSettings.width + 'x' + newSettings.height + '@' + newSettings.frameRate + 'fps'
                            };
                            
                        } catch (error) {
                            console.error('[VIDEO-QUALITY] Error:', error);
                            return { success: false, error: error.message };
                        }
                    })();
                `);
                
                if (result.success) {
                    log.info(`[STREAM-ELECTRON] Video quality changed to: ${result.quality}`);
                }
                
                return result;
                
            } catch (error: any) {
                log.error(`[STREAM-ELECTRON] Failed to change quality: ${error.message}`);
                return { success: false };
            }
    }

    async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
        try {
            // Закрываем предыдущее окно если есть
            await this.closeWindow();

            // Даем время на очистку
            await new Promise(resolve => setTimeout(resolve, 500));

            const server = options.serverUrl || 'https://jitsi-connectrm.ru';
            const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
            const displayName = options.displayName || 'Guest';

            log.info(`Creating Jitsi window: ${server}/${roomName}`);

            // Создаем окно
            this.state.window = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            title: `Конференция: ${roomName}`,
            icon: this.iconPath,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                webSecurity: false,
                partition: `jitsi-${Date.now()}`,
                preload: path.join(this.bundlePath, "preload.js")
            },
            show: true,
            center: true
            });

            // Формируем URL
            const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
            
            log.info(`Loading conference URL: ${conferenceUrl}`);
            
            // ВАЖНО: Ждем полной загрузки страницы
            await this.state.window.loadURL(conferenceUrl);

            this.state.window.webContents.on('did-finish-load', async () => {
                log.info("[JITSI-MANAGER] Page loaded, injecting debug overlay...");
                
                // Небольшая задержка для инициализации DOM
                setTimeout(async () => {
                    await this.injectDebugOverlay();
                    await this.startDebugMonitoring();
                }, 1000);
            });

            // Также пробуем инъектировать при навигации
            this.state.window.webContents.on('did-navigate', async () => {
                log.info("[JITSI-MANAGER] Navigation detected, re-injecting debug overlay...");
                setTimeout(async () => {
                    await this.injectDebugOverlay();
                }, 1000);
            });
            
            // Ждем загрузки Jitsi и инжектируем обработчики несколько раз
            // Первая попытка через 3 секунды
            setTimeout(() => {
            log.info("First injection attempt (3s)...");
            this.injectHandlers();
            }, 3000);
            
            // Вторая попытка через 5 секунд (если первая не сработала)
            setTimeout(() => {
            log.info("Second injection attempt (5s)...");
            this.injectHandlers();
            }, 5000);
            
            // Третья попытка через 8 секунд (для медленного интернета)
            setTimeout(() => {
            log.info("Third injection attempt (8s)...");
            this.injectHandlers();
            }, 8000);

            this.state.window.on('close', async (event) => {
                log.info("[STREAM-ELECTRON] Window close event triggered");
                
                // Предотвращаем немедленное закрытие
                event.preventDefault();

                const left = await this.leaveConference();
                if (left) {
                    log.info("[STREAM-ELECTRON] Successfully left conference");
                    // Даем время на отправку пакетов выхода
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                // Выполняем cleanup асинхронно
                await this.cleanup();
                
                // Теперь разрешаем закрытие
                if (this.state.window && !this.state.window.isDestroyed()) {
                    this.state.window.destroy();
                }
                
                this.state.window = null;
            });

            // Обработчик закрытия
            this.state.window.on('closed', () => {
                log.info("[STREAM-ELECTRON] Window closed event");
                this.state.window = null;
            });

            // Слушаем консоль для отладки
            this.state.window.webContents.on('console-message', (event, level, message) => {
            if (message.includes('[JitsiDebug]') || 
                message.includes('[JitsiManager]') || 
                message.includes('[NativeStream]') ||
                message.includes('[SourcePicker]')) {
                log.info(`Jitsi Console: ${message}`);
            }
            });

            return { success: true };

        } catch (error: any) {
            log.error(`Failed to create Jitsi window: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async leaveConference(): Promise<boolean> {
        if (!this.state.window || this.state.window.isDestroyed()) {
            return false;
        }
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[JitsiManager] Attempting to leave conference...');
                    
                    // Отключаем все треки перед выходом
                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => {
                            track.stop();
                            console.log('[JitsiManager] Stopped track:', track.kind);
                        });
                    }
                    
                    // Выходим из конференции
                    if (window.APP && window.APP.conference) {
                        // Метод 1: hangup
                        if (window.APP.conference.hangup) {
                            window.APP.conference.hangup(true);
                            console.log('[JitsiManager] Called hangup()');
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            return true;
                        }
                        
                        // Метод 2: room.leave
                        if (window.APP.conference._room && window.APP.conference._room.leave) {
                            await window.APP.conference._room.leave();
                            console.log('[JitsiManager] Called room.leave()');
                            return true;
                        }
                    }
                    
                    return false;
                })();
            `);
            
            return result;
            
        } catch (error: any) {
            log.error(`[JitsiManager] Error leaving conference: ${error.message}`);
            return false;
        }
    }

    async resetManager(): Promise<void> {
        log.info("[STREAM-ELECTRON] >>> Full reset initiated");
        
        try {
            // Останавливаем все
            await this.closeWindow();
            
            // Ждем немного
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Сбрасываем все состояния
            this.state = {
                window: null,
                isStreamActive: false,
                streamId: null,
                lastSelectedSourceId: undefined,
                videoFrameCount: 0,
                audioFrameCount: 0
            };
            
            // Переинициализируем менеджер качества
            this.videoQualityManager = new VideoQualityManager();
            if (this.config.videoQuality) {
                this.videoQualityManager.setPreset(this.config.videoQuality);
            }
            
            log.info("[STREAM-ELECTRON] <<< Reset completed");
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Reset error: ${error.message}`);
        }
    }

    private buildConferenceUrl(server: string, roomName: string, options: JitsiOptions): string {
        let url = `${server}/${roomName}`;

        // Query параметры (JWT токен)
        const queryParams = new URLSearchParams();
        if (options.jwt) queryParams.append('jwt', options.jwt);
        
        if (queryParams.toString()) {
            url += '?' + queryParams.toString();
        }

        // Hash параметры для конфигурации
        const hashParams = new URLSearchParams();
        
        // === ОСНОВНЫЕ НАСТРОЙКИ ===
        hashParams.append('config.prejoinPageEnabled', 'false');
        hashParams.append('config.startWithAudioMuted', 'false');
        hashParams.append('config.startWithVideoMuted', 'true');
        
        // === НАСТРОЙКИ ЛОГИРОВАНИЯ ===
        hashParams.append('config.apiLogLevels', JSON.stringify(['error']));
        hashParams.append('config.logging.defaultLogLevel', 'error');
        
        // === НАСТРОЙКИ ВИДЕО И АУДИО ===
        hashParams.append('config.disableSimulcast', 'true');
        hashParams.append('config.disableAudioLevels', 'false');
        hashParams.append('config.stereo', 'false');
        hashParams.append('config.resolution', '720');
        
        // === НАСТРОЙКИ ОБРАБОТКИ АУДИО ===
        hashParams.append('config.echoCancellation', 'true');
        hashParams.append('config.noiseSuppression', 'true');
        hashParams.append('config.highpassFilter', 'true');
        hashParams.append('config.autoGainControl', 'true');
        hashParams.append('config.enableLipSync', 'false');
        
        // === НАСТРОЙКИ ДЕМОНСТРАЦИИ ЭКРАНА ===
        hashParams.append('config.desktopSharingFrameRate.min', '15');
        hashParams.append('config.desktopSharingFrameRate.max', '30');
        
        // Разрешение для демонстрации экрана
        hashParams.append('config.constraints.video.width.min', '480');
        hashParams.append('config.constraints.video.width.ideal', '800');
        hashParams.append('config.constraints.video.width.max', '900');
        hashParams.append('config.constraints.video.height.min', '360');
        hashParams.append('config.constraints.video.height.ideal', '500');
        hashParams.append('config.constraints.video.height.max', '720');
        hashParams.append('config.constraints.video.frameRate.min', '15');
        hashParams.append('config.constraints.video.frameRate.max', '30');
        
        // Настройки для desktop sharing
        hashParams.append('config.desktopSharingConstraints.video.width.min', '360');
        hashParams.append('config.desktopSharingConstraints.video.width.ideal', '800');
        hashParams.append('config.desktopSharingConstraints.video.width.max', '900');
        hashParams.append('config.desktopSharingConstraints.video.height.min', '480');
        hashParams.append('config.desktopSharingConstraints.video.height.ideal', '500');
        hashParams.append('config.desktopSharingConstraints.video.height.max', '800');
        hashParams.append('config.desktopSharingConstraints.video.frameRate.min', '15');
        hashParams.append('config.desktopSharingConstraints.video.frameRate.max', '30');
        
        // === ОТКЛЮЧЕНИЕ ФУНКЦИЙ ИНТЕРФЕЙСА ===
        hashParams.append('config.hideConferenceSubject', 'true');
        hashParams.append('config.deeplinking.disabled', 'true');
        hashParams.append('config.disableRemoteMute', 'true');
        hashParams.append('config.disableKick', 'true');
        hashParams.append('config.disableGrantModerator', 'true');
        hashParams.append('config.disablePrivateChat', 'true');
        hashParams.append('config.disableSelfViewSettings', 'true');
        hashParams.append('config.disableLocalVideoFlip', 'true');
        hashParams.append('config.disableLocalStats', 'true');
        hashParams.append('config.disableAVModeration', 'true');
        hashParams.append('config.disableInviteFunctions', 'true');
        
        // Настройки панели участников
        hashParams.append('config.participantsPane.hideMoreActionsButton', 'true');
        hashParams.append('config.breakoutRooms.hideMoreActionsButton', 'true');
        
        // Настройки filmstrip
        hashParams.append('config.filmstrip.disableStageFilmstrip', 'true');
        hashParams.append('config.filmstrip.disableResizable', 'true');
        
        // === НАСТРОЙКИ ИНТЕРФЕЙСА ===
        hashParams.append('interfaceConfig.DISABLE_VIDEO_BACKGROUND', 'true');
        hashParams.append('interfaceConfig.DISABLE_DOMINANT_SPEAKER_INDICATOR', 'true');
        
        // Кнопки тулбара - только необходимые
        const toolbarButtons = [
            'camera',
            'desktop',
            'microphone', 
            'settings',
            'fullscreen',
            'hangup'
        ];
        hashParams.append('interfaceConfig.TOOLBAR_BUTTONS', JSON.stringify(toolbarButtons));
        
        // === ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ ===
        if (options.displayName) {
            hashParams.append('userInfo.displayName', options.displayName);
        }
        if (options.email) {
            hashParams.append('userInfo.email', options.email);
        }
        if (options.avatarUrl) {
            hashParams.append('userInfo.avatarURL', options.avatarUrl);
        }
        
        // === ИСТОЧНИКИ ДЛЯ ДЕМОНСТРАЦИИ ===
        hashParams.append('config.desktopSharingSources', JSON.stringify(['screen', 'window']));
        
        // === ДОПОЛНИТЕЛЬНЫЕ НАСТРОЙКИ ===
        hashParams.append('config.enableWelcomePage', 'false');
        hashParams.append('config.enableClosePage', 'false');
        hashParams.append('config.fileRecordingsEnabled', 'false');
        hashParams.append('config.liveStreamingEnabled', 'false');
        hashParams.append('config.transcribingEnabled', 'false');
        hashParams.append('config.enableCalendarIntegration', 'false');
        hashParams.append('config.enableNoAudioDetection', 'false');
        hashParams.append('config.enableNoisyMicDetection', 'false');
        hashParams.append('config.enableSaveLogs', 'false');
        hashParams.append('config.disableThirdPartyRequests', 'true');
        hashParams.append('config.p2p.enabled', 'false');
        
        // Добавляем hash параметры к URL
        if (hashParams.toString()) {
            url += '#' + hashParams.toString();
        }

        return url;
    }

    private async injectHandlers(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;

        try {
            // Сначала проверяем, готов ли Jitsi
            const isReady = await this.state.window.webContents.executeJavaScript(`
                (function() {
                    const ready = !!(window.JitsiMeetJS && window.APP && window.APP.conference);
                    console.log('[JitsiDebug] Checking readiness:', {
                        hasJitsiMeetJS: !!window.JitsiMeetJS,
                        hasAPP: !!window.APP,
                        hasConference: !!(window.APP && window.APP.conference),
                        ready: ready
                    });
                    return ready;
                })();
            `);

            if (!isReady) {
                log.warn("Jitsi not ready yet, skipping injection");
                return;
            }

            log.info("Jitsi is ready, injecting handlers...");

            // Проверяем, не инжектировали ли уже
            const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
                !!(window.jitsiHandlersInjected)
            `);

            if (alreadyInjected) {
                log.info("Handlers already injected, skipping");
                return;
            }

            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    // Помечаем, что инжекция выполнена
                    if (window.jitsiHandlersInjected) {
                        console.log('[JitsiNative] Handlers already injected');
                        return;
                    }
                    window.jitsiHandlersInjected = true;
                    
                    console.log('[JitsiNative] Starting complete injection...');
                    
                    
                    // === СОХРАНЯЕМ ОРИГИНАЛЬНЫЕ ФУНКЦИИ ===
                    const originalFunctions = {
                        openDesktopPicker: null,
                        obtainDesktopStream: null,
                        createLocalTracks: null,
                        getDisplayMedia: null,
                        getUserMedia: null
                    };
                    
                    // === КРИТИЧЕСКИЙ ПЕРЕХВАТ: JitsiMeetJS.createLocalTracks ===
                    if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                        console.log('[JitsiNative] Saving original createLocalTracks');
                        originalFunctions.createLocalTracks = window.JitsiMeetJS.createLocalTracks;
                        
                        window.JitsiMeetJS.createLocalTracks = async function(options) {
                            console.log('[JitsiNative] createLocalTracks intercepted, options:', options);
                            
                            // Проверяем, запрашивается ли desktop
                            if (options && options.devices && options.devices.includes('desktop')) {
                                console.log('[JitsiNative] Desktop track requested');
                                
                                // Проверяем наличие native stream
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] 🎯 Native stream available, injecting it...');
                                    
                                    try {
                                        // КРИТИЧЕСКИЙ ТРЮК: Временно подменяем getUserMedia и getDisplayMedia
                                        const tempGetUserMedia = navigator.mediaDevices.getUserMedia;
                                        const tempGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                                        
                                        // Подменяем getUserMedia
                                        navigator.mediaDevices.getUserMedia = async function(constraints) {
                                            console.log('[JitsiNative] getUserMedia intercepted in createLocalTracks');
                                            if (constraints && constraints.video && 
                                                constraints.video.mandatory && 
                                                constraints.video.mandatory.chromeMediaSource === 'desktop') {
                                                console.log('[JitsiNative] Returning native stream for desktop getUserMedia');
                                                return window.jitsiNativeMediaStream;
                                            }
                                            return tempGetUserMedia.call(this, constraints);
                                        };
                                        
                                        // Подменяем getDisplayMedia
                                        navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                                            console.log('[JitsiNative] getDisplayMedia intercepted in createLocalTracks');
                                            console.log('[JitsiNative] 🎯 RETURNING NATIVE STREAM!');
                                            return window.jitsiNativeMediaStream;
                                        };
                                        
                                        // Вызываем оригинальную функцию с подмененными методами
                                        console.log('[JitsiNative] Calling original createLocalTracks...');
                                        const tracks = await originalFunctions.createLocalTracks.call(this, options);
                                        
                                        // Восстанавливаем оригинальные методы
                                        navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                        navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                        
                                        if (tracks && tracks.length > 0) {
                                            console.log('[JitsiNative] ✅ JitsiLocalTrack created successfully with native stream');
                                            
                                            // Добавляем обработчик остановки
                                            const originalDispose = tracks[0].dispose;
                                            tracks[0].dispose = function() {
                                                console.log('[JitsiNative] Track dispose called');
                                                window.isNativeActive = false;
                                                updateDebugIndicator();
                                                if (originalDispose) {
                                                    return originalDispose.call(this);
                                                }
                                            };
                                        }
                                        
                                        return tracks;
                                        
                                    } catch (e) {
                                        console.error('[JitsiNative] Error in createLocalTracks:', e);
                                        // Восстанавливаем методы в случае ошибки
                                        navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                        navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                        throw e;
                                    }
                                }
                            }
                            
                            // Для других типов треков вызываем оригинальную функцию
                            return originalFunctions.createLocalTracks.call(this, options);
                        };
                        
                        console.log('[JitsiNative] ✅ createLocalTracks intercepted');
                    }
                    
                    // === ПЕРЕХВАТ JitsiMeetScreenObtainer (для диалога выбора) ===
                    if (window.JitsiMeetScreenObtainer) {
                        console.log('[JitsiNative] Setting up JitsiMeetScreenObtainer interceptors');
                        
                        // openDesktopPicker - для выбора источника
                        if (window.JitsiMeetScreenObtainer.openDesktopPicker) {
                            originalFunctions.openDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                            
                            window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                                console.log('[JitsiNative] openDesktopPicker intercepted');
                                
                                // Если есть native stream, сразу возвращаем его
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] Native stream active, auto-selecting');
                                    setTimeout(() => {
                                        const sourceId = 'native:stream:' + Date.now();
                                        callback(sourceId, { audio: true, screenShareAudio: true });
                                    }, 100);
                                    return;
                                }
                                
                                // Иначе вызываем оригинальный метод (или показываем диалог выбора)
                                return originalFunctions.openDesktopPicker.call(this, options, callback);
                            };
                        }
                        
                        // obtainDesktopStream - для получения stream по sourceId
                        if (window.JitsiMeetScreenObtainer.obtainDesktopStream) {
                            originalFunctions.obtainDesktopStream = window.JitsiMeetScreenObtainer.obtainDesktopStream;
                            
                            window.JitsiMeetScreenObtainer.obtainDesktopStream = function(sourceId, callback, errorCallback) {
                                console.log('[JitsiNative] obtainDesktopStream intercepted, sourceId:', sourceId);
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] Returning native stream from obtainDesktopStream');
                                    setTimeout(() => {
                                        callback(window.jitsiNativeMediaStream);
                                    }, 100);
                                    return;
                                }
                                
                                return originalFunctions.obtainDesktopStream.call(this, sourceId, callback, errorCallback);
                            };
                        }
                        
                        console.log('[JitsiNative] ✅ JitsiMeetScreenObtainer intercepted');
                    }
                    
                    // === ПОСТОЯННЫЕ ПЕРЕХВАТЫ (на всякий случай) ===
                    if (!window.originalGetDisplayMedia) {
                        originalFunctions.getDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                        
                        navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                            console.log('[JitsiNative] Global getDisplayMedia intercepted');
                            
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] 🎯 Returning native stream from global getDisplayMedia');
                                return window.jitsiNativeMediaStream;
                            }
                            
                            return originalFunctions.getDisplayMedia.call(this, constraints);
                        };
                    }
                    
                    if (!window.originalGetUserMedia) {
                        originalFunctions.getUserMedia = navigator.mediaDevices.getUserMedia;
                        
                        navigator.mediaDevices.getUserMedia = async function(constraints) {
                            if (constraints && constraints.video && 
                                constraints.video.mandatory && 
                                constraints.video.mandatory.chromeMediaSource === 'desktop') {
                                console.log('[JitsiNative] Global getUserMedia for desktop intercepted');
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] 🎯 Returning native stream from global getUserMedia');
                                    return window.jitsiNativeMediaStream;
                                }
                            }
                            
                            return originalFunctions.getUserMedia.call(this, constraints);
                        };
                    }
                    
                    // === ФУНКЦИЯ ОЧИСТКИ ===
                    window.cleanupNativeStream = function() {
                        console.log('[JitsiNative] Cleaning up...');
                        
                        // Останавливаем stream
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => track.stop());
                        }
                        
                        // Восстанавливаем оригинальные функции
                        if (originalFunctions.createLocalTracks && window.JitsiMeetJS) {
                            window.JitsiMeetJS.createLocalTracks = originalFunctions.createLocalTracks;
                        }
                        if (originalFunctions.openDesktopPicker && window.JitsiMeetScreenObtainer) {
                            window.JitsiMeetScreenObtainer.openDesktopPicker = originalFunctions.openDesktopPicker;
                        }
                        if (originalFunctions.obtainDesktopStream && window.JitsiMeetScreenObtainer) {
                            window.JitsiMeetScreenObtainer.obtainDesktopStream = originalFunctions.obtainDesktopStream;
                        }
                        if (originalFunctions.getDisplayMedia) {
                            navigator.mediaDevices.getDisplayMedia = originalFunctions.getDisplayMedia;
                        }
                        if (originalFunctions.getUserMedia) {
                            navigator.mediaDevices.getUserMedia = originalFunctions.getUserMedia;
                        }
                        
                        window.isNativeActive = false;
                        window.jitsiNativeMediaStream = null;
                        
                        updateDebugIndicator();
                        console.log('[JitsiNative] Cleanup complete');
                    };
                    
                    console.log('[JitsiNative] ✅ Complete injection finished!');
                    console.log('[JitsiNative] Key intercepts:');
                    console.log('  - JitsiMeetJS.createLocalTracks: ' + (!!originalFunctions.createLocalTracks));
                    console.log('  - JitsiMeetScreenObtainer.openDesktopPicker: ' + (!!originalFunctions.openDesktopPicker));
                    console.log('  - navigator.mediaDevices.getDisplayMedia: ' + (!!originalFunctions.getDisplayMedia));
                    
                    return true;
                })();
            `);

            // Инжектируем перехватчик выбора источников (теперь он будет работать вместе с основным кодом)
            await this.state.window.webContents.executeJavaScript(`
                ${this.getScreenShareInterceptorCode()}
            `);

            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[JitsiManager] Setting up conference leave handler...');
                    
                    let leaveHandled = false;
                    
                    // Функция для отправки события только один раз
                    function notifyConferenceLeft() {
                        if (leaveHandled) return;
                        leaveHandled = true;
                        
                        console.log('[JitsiManager] Conference left - notifying main process...');
                        
                        if (window.ipcRenderer) {
                            window.ipcRenderer.invoke('jitsi:conference-left').then(() => {
                                console.log('[JitsiManager] Main process notified successfully');
                            }).catch(err => {
                                console.error('[JitsiManager] Failed to notify:', err);
                            });
                        }
                    }
                    
                    // Ждем полной загрузки конференции
                    const checkInterval = setInterval(() => {
                        // Проверяем наличие объекта конференции
                        if (window.APP && window.APP.conference && window.APP.conference._room) {
                            clearInterval(checkInterval);
                            
                            const room = window.APP.conference._room;
                            console.log('[JitsiManager] Conference room found, adding listeners...');
                            
                            // Слушаем событие CONFERENCE_LEFT
                            if (window.JitsiMeetJS && window.JitsiMeetJS.events && window.JitsiMeetJS.events.conference) {
                                room.on(
                                    window.JitsiMeetJS.events.conference.CONFERENCE_LEFT,
                                    () => {
                                        console.log('[JitsiManager] CONFERENCE_LEFT event fired!');
                                        notifyConferenceLeft();
                                    }
                                );
                                
                                console.log('[JitsiManager] CONFERENCE_LEFT listener added');
                            }
                            
                            // Альтернативный способ - перехват метода leave
                            const originalLeave = room.leave;
                            room.leave = function(...args) {
                                console.log('[JitsiManager] room.leave() called');
                                notifyConferenceLeft();
                                return originalLeave.apply(this, args);
                            };
                            
                            console.log('[JitsiManager] Conference leave handlers installed successfully');
                        }
                    }, 500);
                    
                    // Останавливаем проверку через 20 секунд
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        console.log('[JitsiManager] Stopped checking for conference room');
                    }, 20000);
                    
                    return true;
                })();
            `);

            await this.screenShareMonitor.injectMonitor(this.state.window);

            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    if (window.__screenShareMonitor) {
                        window.__screenShareMonitor.onStop(async function(source) {
                            console.log('[Monitor] Screen share stopped, source:', source);
                            
                            // Проверяем, действительно ли остановлена демонстрация
                            // и это не ложное срабатывание при старте
                            if (!window.isNativeActive && !window.jitsiNativeMediaStream) {
                                console.log('[Monitor] Native stream already inactive, skipping cleanup');
                                return;
                            }
                            
                            // Добавляем задержку для проверки, что это действительно остановка
                            setTimeout(async () => {
                                // Проверяем еще раз через некоторое время
                                const stillSharing = window.APP?.conference?.isSharingScreen?.() || false;
                                
                                if (!stillSharing) {
                                    console.log('[Monitor] Confirmed: screen share stopped, cleaning up...');
                                    
                                    // Останавливаем только если действительно остановлена демонстрация
                                    if (window.ipcRenderer) {
                                        await window.ipcRenderer.invoke('jitsi:stop-native-capture');
                                    }
                                } else {
                                    console.log('[Monitor] False alarm: still sharing');
                                }
                            }, 1000); // Ждем 1 секунду перед очисткой
                        });
                    }
                })();
            `);

            await this.injectDebugOverlay();

            // 🆕 Настройка debug callback для native capture (ИСПРАВЛЕННАЯ ВЕРСИЯ)
            this.nativeCapture.setDebugCallback((packetInfo) => {
                if (this.state.window && !this.state.window.isDestroyed()) {
                    this.state.window.webContents.executeJavaScript(`
                        if (window.updateAudioPacket) {
                            window.updateAudioPacket(${JSON.stringify(packetInfo)});
                        }
                        if (window.addDebugLog) {
                            window.addDebugLog("📦 Audio packet: ${packetInfo.frameNumber}, ${packetInfo.dataSize}b, ${packetInfo.source}");
                        }
                    `).catch(() => {});
                }
            });


            log.info("✅ Handlers injected successfully");

        } catch (error: any) {
            log.error(`Failed to inject handlers: ${error.message}`);
        }
    }

    // ===== ГЛАВНАЯ ФУНКЦИЯ =====
    async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        log.info("[STREAM-ELECTRON] === START injectNativeStream ===");
        
        // Проверяем, не активен ли уже stream
        if (this.state.isStreamActive) {
            log.warn("[STREAM-ELECTRON] Stream already active, stopping previous...");
            await this.cleanup();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] No active Jitsi window");
            return { success: false, error: "No active Jitsi window" };
        }

        try {
            const sourceId = this.state.lastSelectedSourceId || 'screen:2077748985:0';
            log.info(`[STREAM-ELECTRON] Source ID: ${sourceId}`);
            
            // 1. Запускаем Native аудио захват
            const audioResult = await this.startNativeAudioCapture(sourceId);
            if (!audioResult.success) {
                return { success: false, error: audioResult.error };
            }
            
            // 2. Получаем информацию об источнике
            const sourceInfo = await this.getNativeSourceInfo(sourceId);
            
            // 3. Находим соответствующий Electron источник
            const electronSourceId = await this.findElectronSource(sourceInfo);
            if (!electronSourceId) {
                log.error("[STREAM-ELECTRON] Could not find Electron source");
                await this.nativeCapture.stopCapture();
                return { success: false, error: "No matching Electron source" };
            }
            
            // 4. Создаем гибридный поток в Jitsi
            const streamResult = await this.createHybridStreamInJitsi(electronSourceId);
            if (!streamResult.success) {
                await this.nativeCapture.stopCapture();
                return streamResult;
            }
            
            // 5. Настраиваем callbacks для аудио
            this.setupAudioCallbacks();
            
            // Сохраняем состояние
            this.state.isStreamActive = true;
            this.state.streamId = streamResult.streamId;
            
            log.info("[STREAM-ELECTRON] === SUCCESS injectNativeStream ===");
            log.info(`[STREAM-ELECTRON] Stream ID: ${streamResult.streamId}`);
            log.info(`[STREAM-ELECTRON] Video: ${streamResult.videoQuality}`);
            
            return streamResult;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] === ERROR injectNativeStream: ${error.message} ===`);
            await this.nativeCapture.stopCapture();
            return { success: false, error: error.message };
        }
    }

    private async forceReleaseAllMediaResources(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            // Используем Chrome DevTools Protocol для принудительной остановки
            const cdp = this.state.window.webContents.debugger;
            
            try {
                if (!cdp.isAttached()) {
                    await cdp.attach('1.3');
                }
                
                // Останавливаем все медиа сессии
                await cdp.sendCommand('Page.stopScreencast');
                await cdp.sendCommand('Browser.resetPermissions');
                
                await cdp.detach();
            } catch (cdpError) {
                log.warn(`[STREAM-ELECTRON] CDP cleanup error: ${cdpError}`);
            }
            
            // Принудительно вызываем Garbage Collection
            await this.state.window.webContents.executeJavaScript(`
                if (typeof gc !== 'undefined') {
                    gc();
                    gc(); // Вызываем дважды для полной очистки
                }
            `);
            
            // Сбрасываем медиа сессию
            const session = this.state.window.webContents.session;
            await session.clearCache();
            
            log.info("[STREAM-ELECTRON] Forced release of all media resources");
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error releasing media resources: ${error.message}`);
        }
    }

    // ===== 1. ЗАПУСК NATIVE АУДИО =====
    private async startNativeAudioCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        log.info("[STREAM-ELECTRON] >>> startNativeAudioCapture");
        
        try {
            // Для гибридного режима используем оптимизированный audio-only захват
            if (this.config.useHybridMode) {
                log.info("[STREAM-ELECTRON] Using optimized audio-only capture for hybrid mode");
                
                // Используем новый оптимизированный метод
                const result = await this.nativeCapture.startAudioOnlyCapture(sourceId);
                
                if (result.success) {
                    log.info("[STREAM-ELECTRON] ✅ Audio-only capture started (CPU optimized)");
                } else {
                    log.error(`[STREAM-ELECTRON] ❌ Audio-only capture failed: ${result.error}`);
                }
                
                log.info("[STREAM-ELECTRON] <<< startNativeAudioCapture");
                return result;
            }
            
            // Для non-hybrid режима используем полный захват
            log.info("[STREAM-ELECTRON] Using full audio+video capture for native mode");
            const result = await this.nativeCapture.startAudioVideoCapture(sourceId);
            
            if (result.success) {
                log.info("[STREAM-ELECTRON] <<< startNativeAudioCapture SUCCESS (full capture)");
            } else {
                log.error(`[STREAM-ELECTRON] <<< startNativeAudioCapture FAILED: ${result.error}`);
            }
            
            return result;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] <<< startNativeAudioCapture ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // ===== 2. ПОЛУЧЕНИЕ ИНФОРМАЦИИ ОБ ИСТОЧНИКЕ =====
    private async getNativeSourceInfo(sourceId: string): Promise<{ name: string; type: string }> {
        log.info(`[STREAM-ELECTRON] >>> getNativeSourceInfo: ${sourceId}`);
        
        try {
            const nativeSources = await this.nativeCapture.getSources();
            
            const source = nativeSources.find(s => {
                return s.id === sourceId || 
                    `screen:${s.id}:0` === sourceId ||
                    `window:${s.id}:0` === sourceId;
            });
            
            if (source) {
                log.info(`[STREAM-ELECTRON] <<< getNativeSourceInfo: ${source.name} (${source.type})`);
                return { name: source.name || '', type: source.type || '' };
            }
            
            // Fallback по формату
            if (sourceId.startsWith('screen:')) {
                log.info("[STREAM-ELECTRON] <<< getNativeSourceInfo: Screen (fallback)");
                return { name: 'Screen', type: 'screen' };
            } else if (sourceId.startsWith('window:')) {
                log.info("[STREAM-ELECTRON] <<< getNativeSourceInfo: Window (fallback)");
                return { name: 'Window', type: 'window' };
            }
            
            log.warn("[STREAM-ELECTRON] <<< getNativeSourceInfo: Unknown");
            return { name: '', type: '' };
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] <<< getNativeSourceInfo ERROR: ${error.message}`);
            return { name: '', type: '' };
        }
    }

    // ===== 3. ПОИСК ELECTRON ИСТОЧНИКА =====
    private async findElectronSource(sourceInfo: { name: string; type: string }): Promise<string | null> {
        log.info(`[STREAM-ELECTRON] >>> findElectronSource: ${sourceInfo.name} (${sourceInfo.type})`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] <<< findElectronSource: No window");
            return null;
        }
        
        try {
            const electronSourceId = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[STREAM-ELECTRON] Finding Electron source...');
                    
                    // Получаем источники через IPC
                    const sources = await window.ipcRenderer.invoke('get-desktop-sources');
                    console.log('[STREAM-ELECTRON] Got', sources.length, 'sources');
                    
                    const nativeName = '${sourceInfo.name}';
                    const nativeType = '${sourceInfo.type}';
                    
                    let matchedSource = null;
                    
                    if (nativeType === 'screen' || nativeType === 'display') {
                        matchedSource = sources.find(s => s.id.startsWith('screen:'));
                    } else if (nativeType === 'window') {
                        // Ищем по имени
                        matchedSource = sources.find(s => {
                            if (!s.id.startsWith('window:')) return false;
                            
                            const nameMatch = s.name && nativeName && 
                                s.name.toLowerCase().includes(nativeName.toLowerCase());
                            
                            return nameMatch;
                        });
                        
                        // Fallback на первое окно
                        if (!matchedSource) {
                            matchedSource = sources.find(s => s.id.startsWith('window:'));
                        }
                    }
                    
                    if (!matchedSource) {
                        matchedSource = sources[0];
                    }
                    
                    if (matchedSource) {
                        console.log('[STREAM-ELECTRON] Matched:', matchedSource.id, matchedSource.name);
                        return matchedSource.id;
                    }
                    
                    return null;
                })();
            `);
            
            log.info(`[STREAM-ELECTRON] <<< findElectronSource: ${electronSourceId || 'NOT FOUND'}`);
            return electronSourceId;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] <<< findElectronSource ERROR: ${error.message}`);
            return null;
        }
    }

    // ===== 4. СОЗДАНИЕ ГИБРИДНОГО ПОТОКА =====
    private async createHybridStreamInJitsi(electronSourceId: string): Promise<any> {
        log.info(`[STREAM-ELECTRON] >>> createHybridStreamInJitsi: ${electronSourceId}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] <<< createHybridStreamInJitsi: No window");
            return { success: false, error: "No window" };
        }
        
        // ВАЖНО: Получаем текущие настройки качества
        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        log.info(`[STREAM-ELECTRON] Using quality preset: ${qualitySettings.name} - ${qualitySettings.description}`);
        log.info(`[STREAM-ELECTRON] Video constraints: ${qualitySettings.width.min}-${qualitySettings.width.max}x${qualitySettings.height.min}-${qualitySettings.height.max} @ ${qualitySettings.frameRate.min}-${qualitySettings.frameRate.max}fps`);
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    const isWindows = ${this.isWindowsPlatform()};
                    console.log('[STREAM-ELECTRON] Creating hybrid stream, platform:', isWindows ? 'Windows' : 'macOS');
                    
                    try {
                        // 1. Получаем VIDEO - одинаково для всех платформ
                        const videoStream = await navigator.mediaDevices.getUserMedia({
                            audio: false,
                            video: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: '${electronSourceId}',
                                    minWidth: ${qualitySettings.width.min},
                                    maxWidth: ${qualitySettings.width.max},
                                    minHeight: ${qualitySettings.height.min},
                                    maxHeight: ${qualitySettings.height.max},
                                    minFrameRate: ${qualitySettings.frameRate.min},
                                    maxFrameRate: ${qualitySettings.frameRate.max}
                                }
                            }
                        });
                        
                        const videoTrack = videoStream.getVideoTracks()[0];
                        
                        // Сохраняем начальное время для синхронизации
                        window.streamStartTime = performance.now();
                        window.lastVideoFrameTime = window.streamStartTime;
                        
                        // 2. Создаем AUDIO контекст с оптимальными настройками
                        const audioContext = new AudioContext({ 
                            sampleRate: 48000,
                            latencyHint: isWindows ? 'playback' : 'interactive'
                        });
                        
                        // Для Windows используем больший буфер для стабильности
                        const bufferSize = isWindows ? 4096 : 2048;
                        const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 0, 2);
                        
                        // 3. Создаем буферы - разные для разных платформ
                        if (isWindows) {
                            // Windows-специфичный буфер с улучшенной синхронизацией
                            class WindowsAdaptiveBuffer {
                                constructor(size) {
                                    this.leftBuffer = new Float32Array(size);
                                    this.rightBuffer = new Float32Array(size);
                                    this.writeIndex = 0;
                                    this.readIndex = 0;
                                    this.availableSamples = 0;
                                    this.size = size;
                                    
                                    // Параметры адаптивной буферизации
                                    this.targetLatency = 2048; // ~42ms при 48kHz
                                    this.minLatency = 960;     // ~20ms
                                    this.maxLatency = 4800;    // ~100ms
                                    
                                    // Для сглаживания
                                    this.lastSampleLeft = 0;
                                    this.lastSampleRight = 0;
                                    
                                    // Статистика
                                    this.underruns = 0;
                                    this.overruns = 0;
                                }
                                
                                writeWithTimestamp(leftData, rightData, timestamp) {
                                    // Проверяем переполнение
                                    if (this.availableSamples > this.maxLatency) {
                                        this.overruns++;
                                        // Пропускаем старые данные
                                        const toSkip = this.availableSamples - this.targetLatency;
                                        this.readIndex = (this.readIndex + toSkip) % this.size;
                                        this.availableSamples = this.targetLatency;
                                        
                                        if (this.overruns % 10 === 0) {
                                            console.warn('[AUDIO] Buffer overrun, adjusting...', this.overruns);
                                        }
                                    }
                                    
                                    // Записываем данные
                                    for (let i = 0; i < leftData.length; i++) {
                                        this.leftBuffer[this.writeIndex] = leftData[i];
                                        this.rightBuffer[this.writeIndex] = rightData[i];
                                        this.writeIndex = (this.writeIndex + 1) % this.size;
                                        this.availableSamples = Math.min(this.availableSamples + 1, this.size);
                                    }
                                }
                                
                                read(leftOutput, rightOutput) {
                                    const requestedSamples = leftOutput.length;
                                    
                                    // Проверяем наличие данных
                                    if (this.availableSamples < this.minLatency) {
                                        this.underruns++;
                                        
                                        // Заполняем тишиной с плавным затуханием
                                        for (let i = 0; i < requestedSamples; i++) {
                                            const fade = Math.exp(-i / requestedSamples * 3);
                                            leftOutput[i] = this.lastSampleLeft * fade;
                                            rightOutput[i] = this.lastSampleRight * fade;
                                        }
                                        
                                        if (this.underruns % 10 === 0) {
                                            console.warn('[AUDIO] Buffer underrun:', this.underruns);
                                        }
                                        return 0;
                                    }
                                    
                                    // Читаем доступные данные
                                    const samplesToRead = Math.min(requestedSamples, this.availableSamples);
                                    
                                    for (let i = 0; i < samplesToRead; i++) {
                                        // Простое сглаживание для уменьшения щелчков
                                        const smoothFactor = 0.95;
                                        const rawLeft = this.leftBuffer[this.readIndex];
                                        const rawRight = this.rightBuffer[this.readIndex];
                                        
                                        leftOutput[i] = rawLeft * smoothFactor + this.lastSampleLeft * (1 - smoothFactor);
                                        rightOutput[i] = rawRight * smoothFactor + this.lastSampleRight * (1 - smoothFactor);
                                        
                                        this.lastSampleLeft = leftOutput[i];
                                        this.lastSampleRight = rightOutput[i];
                                        
                                        this.readIndex = (this.readIndex + 1) % this.size;
                                    }
                                    
                                    // Заполняем оставшееся тишиной если нужно
                                    for (let i = samplesToRead; i < requestedSamples; i++) {
                                        leftOutput[i] = 0;
                                        rightOutput[i] = 0;
                                    }
                                    
                                    this.availableSamples = Math.max(0, this.availableSamples - samplesToRead);
                                    
                                    // Периодический лог статистики
                                    if (window.audioCounter && window.audioCounter % 100 === 0) {
                                        console.log('[AUDIO] Buffer:', this.availableSamples, 
                                                'samples, Under/Over:', this.underruns + '/' + this.overruns);
                                    }
                                    
                                    return samplesToRead;
                                }
                            }
                            
                            // Создаем адаптивный буфер для Windows
                            window.windowsRingBuffer = new WindowsAdaptiveBuffer(96000);
                            
                            scriptProcessor.onaudioprocess = (event) => {
                                if (!window.isNativeActive) {
                                    event.outputBuffer.getChannelData(0).fill(0);
                                    event.outputBuffer.getChannelData(1).fill(0);
                                    return;
                                }
                                
                                window.windowsRingBuffer.read(
                                    event.outputBuffer.getChannelData(0),
                                    event.outputBuffer.getChannelData(1)
                                );
                                
                                // Применяем лимитер для защиты от клиппинга
                                const leftChannel = event.outputBuffer.getChannelData(0);
                                const rightChannel = event.outputBuffer.getChannelData(1);
                                
                                for (let i = 0; i < leftChannel.length; i++) {
                                    // Hard limit at 0.99 to prevent clipping
                                    leftChannel[i] = Math.max(-0.99, Math.min(0.99, leftChannel[i]));
                                    rightChannel[i] = Math.max(-0.99, Math.min(0.99, rightChannel[i]));
                                }
                            };
                            
                        } else {
                            // macOS - СУЩЕСТВУЮЩИЙ КОД БЕЗ ИЗМЕНЕНИЙ
                            class RingBuffer {
                                constructor(size) {
                                    this.buffer = new Float32Array(size);
                                    this.writeIndex = 0;
                                    this.readIndex = 0;
                                    this.availableSamples = 0;
                                    this.size = size;
                                }
                                write(data) {
                                    for (let i = 0; i < data.length; i++) {
                                        this.buffer[this.writeIndex] = data[i];
                                        this.writeIndex = (this.writeIndex + 1) % this.size;
                                        this.availableSamples = Math.min(this.availableSamples + 1, this.size);
                                    }
                                }
                                read(output) {
                                    const samplesToRead = Math.min(output.length, this.availableSamples);
                                    for (let i = 0; i < samplesToRead; i++) {
                                        output[i] = this.buffer[this.readIndex];
                                        this.readIndex = (this.readIndex + 1) % this.size;
                                    }
                                    for (let i = samplesToRead; i < output.length; i++) {
                                        output[i] = 0;
                                    }
                                    this.availableSamples = Math.max(0, this.availableSamples - samplesToRead);
                                    return samplesToRead;
                                }
                            }
                            
                            const leftRingBuffer = new RingBuffer(48000);
                            const rightRingBuffer = new RingBuffer(48000);
                            
                            window.leftRingBuffer = leftRingBuffer;
                            window.rightRingBuffer = rightRingBuffer;
                            
                            scriptProcessor.onaudioprocess = (event) => {
                                if (!window.isNativeActive) {
                                    event.outputBuffer.getChannelData(0).fill(0);
                                    event.outputBuffer.getChannelData(1).fill(0);
                                    return;
                                }
                                leftRingBuffer.read(event.outputBuffer.getChannelData(0));
                                rightRingBuffer.read(event.outputBuffer.getChannelData(1));
                            };
                        }
                        
                        const destination = audioContext.createMediaStreamDestination();
                        scriptProcessor.connect(destination);
                        
                        // 4. Создаем гибридный поток - одинаково для всех
                        const hybridStream = new MediaStream();
                        hybridStream.addTrack(videoTrack);
                        
                        if (destination.stream.getAudioTracks().length > 0) {
                            hybridStream.addTrack(destination.stream.getAudioTracks()[0]);
                        }
                        
                        // 5. Сохраняем в window
                        window.jitsiNativeMediaStream = hybridStream;
                        window.nativeAudioContext = audioContext;
                        window.isNativeActive = true;
                        window.isHybridMode = true;
                        window.audioCounter = 0;
                        window.platformMode = isWindows ? 'windows-adaptive' : 'macos-standard';
                        
                        if (audioContext.state === 'suspended') {
                            await audioContext.resume();
                        }
                        
                        console.log('[STREAM-ELECTRON] ✅ Hybrid stream ready!');
                        console.log('[STREAM-ELECTRON] Mode:', window.platformMode);
                        console.log('[STREAM-ELECTRON] Buffer size:', bufferSize);
                        
                        return {
                            success: true,
                            streamId: hybridStream.id,
                            mode: window.platformMode,
                            audioBufferSize: bufferSize
                        };
                        
                    } catch (error) {
                        console.error('[STREAM-ELECTRON] Error:', error);
                        return { success: false, error: error.message };
                    }
                })();
            `);
            
            if (result.success) {
                this.activeMediaStreams.clear();
                this.activeMediaStreams.add(result.streamId);
                
                log.info(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi SUCCESS`);
                log.info(`[STREAM-ELECTRON] Mode: ${result.mode}`);
                log.info(`[STREAM-ELECTRON] Audio buffer: ${result.audioBufferSize}`);
            } else {
                log.error(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi FAILED: ${result.error}`);
            }
            
            return result;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    getAvailableQualityPresets(): Array<{ key: string; name: string; description: string }> {
        return Object.entries(VIDEO_QUALITY_PRESETS).map(([key, preset]) => ({
            key,
            name: preset.name,
            description: preset.description
        }));
    }

    getCurrentVideoQuality(): string {
        const settings = this.videoQualityManager.getCurrentSettings();
        return `${settings.width.max}x${settings.height.max}@${settings.frameRate.max}fps`;
    }

    async setQualityForScenario(scenario: 'gaming' | 'presentation' | 'video' | 'coding'): Promise<void> {
        const scenarioMap = {
            'gaming': 'ULTRA',        // Высокий FPS
            'presentation': 'PRESENTATION', // Низкий FPS, высокое разрешение
            'video': 'HIGH',          // Баланс
            'coding': 'MEDIUM'        // Экономия ресурсов
        };
        
        const preset = scenarioMap[scenario] as keyof typeof VIDEO_QUALITY_PRESETS;
        await this.changeVideoQuality(preset);
    }


    // ===== 5. НАСТРОЙКА AUDIO CALLBACKS =====
    private setupAudioCallbacks(): void {
        log.info("[STREAM-ELECTRON] >>> setupAudioCallbacks");
        
        this.state.videoFrameCount = 0;
        this.state.audioFrameCount = 0;
        
        this.nativeCapture.setFrameCallbacks(
            // Video callback - игнорируем
            (videoData: any) => {
                this.state.videoFrameCount++;
                this.lastVideoTimestamp = performance.now();
                if (this.state.videoFrameCount === 1) {
                    log.info("[STREAM-ELECTRON] Ignoring native video (using Electron)");
                }
            },
            
            // Audio callback - обрабатываем
            (audioData: any) => {
                this.processNativeAudio(audioData);
            }
        );
        
        log.info("[STREAM-ELECTRON] <<< setupAudioCallbacks DONE");
    }

    // ===== 6. ОБРАБОТКА NATIVE АУДИО =====
    private processNativeAudio(audioData: any): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        this.state.audioFrameCount++;
        
        // Используем улучшенную обработку ТОЛЬКО для Windows
        if (this.isWindowsPlatform() && audioData.syncTimestamp) {
            this.processNativeAudioWindows(audioData);
        } else {
            // ДЛЯ macOS - СУЩЕСТВУЮЩИЙ КОД БЕЗ ИЗМЕНЕНИЙ
            this.processNativeAudioOriginal(audioData);
        }
    }
    
    // Сохраняем оригинальный метод для macOS
    private processNativeAudioOriginal(audioData: any): void {
        // ВАШ СУЩЕСТВУЮЩИЙ КОД ИЗ processNativeAudio
        // Копируем сюда весь существующий рабочий код для macOS
        
        try {
            const arrayBuffer = audioData.data;
            const samples = audioData.numSamples || 960;
            const channels = audioData.channels || 2;
            
            const { leftChannel, rightChannel } = this.decodeAudioData(arrayBuffer, samples, channels);
            const levels = this.analyzeAudioLevels(leftChannel, rightChannel);
            
            if (this.state.audioFrameCount % 50 === 0) {
                log.info(`[STREAM-ELECTRON] Audio: Frame ${this.state.audioFrameCount}, ` +
                        `L=${levels.maxLeft.toFixed(4)}, R=${levels.maxRight.toFixed(4)}`);
            }
            
            const { processedLeft, processedRight } = this.normalizeAudio(
                leftChannel, 
                rightChannel, 
                levels
            );
            
            // Используем существующий метод отправки
            this.sendAudioToJitsi(processedLeft, processedRight, samples);
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] processNativeAudio ERROR: ${error.message}`);
        }
    }
    
    // Новый метод только для Windows
    private processNativeAudioWindows(audioData: any): void {
        try {
            const arrayBuffer = audioData.data;
            const samples = audioData.numSamples || 960;
            const channels = audioData.channels || 2;
            const timestamp = audioData.timestamp;
            
            const { leftChannel, rightChannel } = this.decodeAudioData(arrayBuffer, samples, channels);
            
            // Применяем адаптивную буферизацию
            const currentVideoTime = this.getLastVideoTimestamp();
            const audioDrift = timestamp - currentVideoTime;
            
            // Корректируем если дрифт слишком большой
            let adjustedTimestamp = timestamp;
            if (Math.abs(audioDrift) > 50) { // 50ms порог
                log.warn(`[WINDOWS-AUDIO] Large drift detected: ${audioDrift}ms`);
                adjustedTimestamp = currentVideoTime + 20; // Целевая задержка 20ms
            }

            // Windows-специфичная нормализация с учетом тайминга
            const { processedLeft, processedRight } = this.normalizeAudioWithTiming(
                leftChannel, 
                rightChannel,
                adjustedTimestamp
            );
            
            // Отправляем с синхронизацией
            this.sendAudioToJitsiWithSync(processedLeft, processedRight, samples, adjustedTimestamp);
            
        } catch (error: any) {
            log.error(`[WINDOWS-AUDIO] Error: ${error.message}`);
            // Fallback на оригинальный метод
            this.processNativeAudioOriginal(audioData);
        }
    }
    
    // Добавляем новый метод для Windows, не трогая существующий sendAudioToJitsi
    private sendAudioToJitsiWithSync(
        leftData: Float32Array, 
        rightData: Float32Array, 
        samples: number,
        timestamp: number
    ): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        const jsCode = `
            (function() {
                if (!window.isNativeActive) return;
                
                const isWindows = ${this.isWindowsPlatform()};
                const timestamp = ${timestamp};
                
                try {
                    const leftData = [${Array.from(leftData).join(',')}];
                    const rightData = [${Array.from(rightData).join(',')}];
                    
                    if (isWindows && window.windowsRingBuffer) {
                        // Windows-специфичная буферизация с таймингом
                        window.windowsRingBuffer.writeWithTimestamp(
                            new Float32Array(leftData),
                            new Float32Array(rightData),
                            timestamp
                        );
                    } else if (window.leftRingBuffer && window.rightRingBuffer) {
                        // Стандартная буферизация для macOS
                        window.leftRingBuffer.write(new Float32Array(leftData));
                        window.rightRingBuffer.write(new Float32Array(rightData));
                    }
                    
                    window.audioCounter = (window.audioCounter || 0) + 1;
                    
                    if (window.audioCounter % 100 === 0) {
                        const mode = isWindows ? 'Windows-Sync' : 'Standard';
                        console.log('[STREAM-ELECTRON] ' + mode + ': ' + window.audioCounter + ' frames');
                    }
                } catch (e) {
                    console.error('[STREAM-ELECTRON] Audio error:', e);
                }
            })();
        `;
        
        this.state.window.webContents.executeJavaScript(jsCode).catch(() => {});
    }

    // ===== 7. ДЕКОДИРОВАНИЕ АУДИО =====
    private decodeAudioData(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): { leftChannel: Float32Array; rightChannel: Float32Array } {
        
        let leftChannel = new Float32Array(samples);
        let rightChannel = new Float32Array(samples);
        
        if (arrayBuffer.byteLength === samples * channels * 4) {
            // Float32 формат
            const dataView = new DataView(arrayBuffer);
            
            // Планарный формат
            const halfSize = arrayBuffer.byteLength / 2;
            for (let i = 0; i < samples; i++) {
                leftChannel[i] = dataView.getFloat32(i * 4, true);
                rightChannel[i] = dataView.getFloat32(halfSize + i * 4, true);
            }
            
            // Проверка на валидность
            let hasData = false;
            for (let i = 0; i < samples; i++) {
                if (Math.abs(leftChannel[i]) > 0.00001 || Math.abs(rightChannel[i]) > 0.00001) {
                    hasData = true;
                    break;
                }
            }
            
            // Если нет данных, пробуем интерливд
            if (!hasData) {
                for (let i = 0; i < samples; i++) {
                    leftChannel[i] = dataView.getFloat32(i * 8, true);
                    rightChannel[i] = dataView.getFloat32(i * 8 + 4, true);
                }
            }
        }
        
        return { leftChannel, rightChannel };
    }

    // ===== 8. АНАЛИЗ УРОВНЕЙ =====
    private analyzeAudioLevels(
        leftChannel: Float32Array, 
        rightChannel: Float32Array
    ): { maxLeft: number; maxRight: number; hasAudio: boolean } {
        
        let maxLeft = 0, maxRight = 0;
        
        for (let i = 0; i < leftChannel.length; i++) {
            maxLeft = Math.max(maxLeft, Math.abs(leftChannel[i]));
            maxRight = Math.max(maxRight, Math.abs(rightChannel[i]));
        }
        
        const hasAudio = maxLeft > 0.00001 || maxRight > 0.00001;
        
        return { maxLeft, maxRight, hasAudio };
    }

    // ===== 9. НОРМАЛИЗАЦИЯ =====
    private normalizeAudio(
        leftChannel: Float32Array,
        rightChannel: Float32Array,
        levels: { maxLeft: number; maxRight: number; hasAudio: boolean }
    ): { processedLeft: Float32Array; processedRight: Float32Array } {
        
        const samples = leftChannel.length;
        const processedLeft = new Float32Array(samples);
        const processedRight = new Float32Array(samples);
        
        if (levels.hasAudio) {
            const targetPeak = 0.7;
            const currentPeak = Math.max(levels.maxLeft, levels.maxRight);
            const gain = currentPeak > 0.001 ? Math.min(targetPeak / currentPeak, 3.0) : 1.0;
            
            for (let i = 0; i < samples; i++) {
                processedLeft[i] = Math.max(-1, Math.min(1, leftChannel[i] * gain));
                processedRight[i] = Math.max(-1, Math.min(1, rightChannel[i] * gain));
            }
        } else {
            processedLeft.set(leftChannel);
            processedRight.set(rightChannel);
        }
        
        return { processedLeft, processedRight };
    }

    // ===== 10. ОТПРАВКА В JITSI =====
    private sendAudioToJitsi(
        leftData: Float32Array, 
        rightData: Float32Array, 
        samples: number
    ): void {
        
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        const jsCode = `
            (function() {
                if (!window.isNativeActive || !window.leftRingBuffer || !window.rightRingBuffer) {
                    return;
                }
                
                try {
                    const leftData = [${Array.from(leftData).join(',')}];
                    const rightData = [${Array.from(rightData).join(',')}];
                    
                    window.leftRingBuffer.write(new Float32Array(leftData));
                    window.rightRingBuffer.write(new Float32Array(rightData));
                    
                    window.audioCounter = (window.audioCounter || 0) + 1;
                    
                    if (window.audioCounter === 1) {
                        console.log('[STREAM-ELECTRON] First audio in buffer!');
                    }
                    
                    if (window.audioCounter % 100 === 0) {
                        const bufferMs = window.leftRingBuffer.availableSamples / 48;
                        console.log('[STREAM-ELECTRON] Audio: ' + window.audioCounter + ' frames, ' + bufferMs.toFixed(0) + 'ms');
                    }
                } catch (e) {
                    console.error('[STREAM-ELECTRON] Audio error:', e);
                }
            })();
        `;
        
        this.state.window.webContents.executeJavaScript(jsCode).catch(() => {});
    }

    async handleSourceSelection(sourceId: string): void {
        this.state.lastSelectedSourceId = sourceId;
        log.info(`Saved selected source: ${sourceId}`);
    }

    async sendSourcesToWindow(sources: any[]): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.warn("No Jitsi window to send sources to");
            return;
        }

        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('🔍 Received ${sources.length} sources in Jitsi');
                    
                    // Сохраняем источники глобально
                    window._availableSources = ${JSON.stringify(sources)};
                    
                    // Если есть ожидающий колбэк для выбора источников
                    if (window._pendingSourcesCallback) {
                        console.log('Found pending sources callback, showing picker...');
                        
                        // Показываем диалог выбора
                        showSourcePicker(window._availableSources, (selectedId) => {
                            console.log('User selected source:', selectedId);
                            
                            const selectedSource = window._availableSources.find(s => s.id === selectedId);
                            window._lastSelectedSourceIsNative = selectedSource?.isNative || false;
                            
                            if (window._pendingSourcesCallback) {
                                window._pendingSourcesCallback(selectedId, {
                                    audio: true,
                                    screenShareAudio: true
                                });
                                window._pendingSourcesCallback = null;
                            }
                        });
                    }
                    
                    // Функция показа диалога выбора источников
                    function showSourcePicker(sources, callback) {
                        // Удаляем предыдущий диалог если есть
                        const existing = document.getElementById('source-picker-overlay');
                        if (existing) existing.remove();
                        
                        const overlay = document.createElement('div');
                        overlay.id = 'source-picker-overlay';
                        overlay.style.cssText = \`
                            position: fixed;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background: rgba(0, 0, 0, 0.85);
                            z-index: 10000;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            backdrop-filter: blur(5px);
                        \`;
                        
                        const dialog = document.createElement('div');
                        dialog.style.cssText = \`
                            background: white;
                            border-radius: 16px;
                            padding: 32px;
                            max-width: 90%;
                            max-height: 80%;
                            overflow: auto;
                            min-width: 700px;
                            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                        \`;
                        
                        let htmlContent = \`
                            <h2 style="margin-top: 0; color: #333; font-size: 24px;">
                                Выберите экран или окно для демонстрации
                            </h2>
                            <div style="
                                display: grid; 
                                grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); 
                                gap: 20px; 
                                margin: 24px 0;
                            ">
                        \`;
                        
                        sources.forEach((source, index) => {
                            const isNative = source.isNative || false;
                            const borderColor = isNative ? '#4CAF50' : '#2196F3';
                            
                            htmlContent += \`
                                <div class="source-item" data-source-id="\${source.id}" style="
                                    border: 3px solid #e0e0e0;
                                    border-radius: 12px;
                                    padding: 16px;
                                    cursor: pointer;
                                    text-align: center;
                                    background: white;
                                    position: relative;
                                    transition: all 0.3s;
                                " onmouseover="this.style.borderColor='\${borderColor}'; this.style.transform='scale(1.05)';" 
                                onmouseout="this.style.borderColor='#e0e0e0'; this.style.transform='scale(1)';">
                                    \${isNative ? \`
                                        <div style="
                                            position: absolute;
                                            top: 10px;
                                            right: 10px;
                                            background: #4CAF50;
                                            color: white;
                                            padding: 4px 8px;
                                            border-radius: 6px;
                                            font-size: 12px;
                                            font-weight: bold;
                                        ">NATIVE</div>
                                    \` : ''}
                                    <img src="\${source.thumbnail?.dataUrl || ''}" style="
                                        width: 100%; 
                                        height: 160px; 
                                        object-fit: contain; 
                                        margin-bottom: 12px;
                                        border-radius: 8px;
                                        background: #f5f5f5;
                                    ">
                                    <div style="
                                        font-size: 14px; 
                                        color: #666; 
                                        word-wrap: break-word;
                                        font-weight: 500;
                                    ">\${source.name || 'Unknown'}</div>
                                </div>
                            \`;
                        });
                        
                        htmlContent += \`
                            </div>
                            <div style="text-align: center; margin-top: 24px;">
                                <button id="cancel-picker-btn" style="
                                    background: #f44336;
                                    color: white;
                                    border: none;
                                    padding: 12px 32px;
                                    border-radius: 8px;
                                    cursor: pointer;
                                    font-size: 16px;
                                    font-weight: 500;
                                ">Отмена</button>
                            </div>
                        \`;
                        
                        dialog.innerHTML = htmlContent;
                        overlay.appendChild(dialog);
                        document.body.appendChild(overlay);
                        
                        // Обработчики кликов
                        overlay.onclick = function(e) {
                            e.stopPropagation();
                            
                            const sourceItem = e.target.closest('.source-item');
                            if (sourceItem) {
                                const sourceId = sourceItem.dataset.sourceId;
                                overlay.remove();
                                callback(sourceId);
                                return;
                            }
                            
                            if (e.target.id === 'cancel-picker-btn' || e.target === overlay) {
                                overlay.remove();
                                return;
                            }
                        };
                        
                        // Escape для закрытия
                        const handleEscape = function(e) {
                            if (e.key === 'Escape') {
                                overlay.remove();
                                document.removeEventListener('keydown', handleEscape);
                            }
                        };
                        document.addEventListener('keydown', handleEscape);
                    }
                    
                    return { success: true, count: ${sources.length} };
                })();
            `);
            
            log.info(`Sent ${sources.length} sources to Jitsi window`);
            
        } catch (error: any) {
            log.error(`Failed to send sources to Jitsi: ${error.message}`);
        }
    }

    async getStatus(): Promise<any> {
        return {
            hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
            isStreamActive: this.state.isStreamActive,
            streamId: this.state.streamId
        };
    }

    async triggerScreenShare(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
            (async function() {
                console.log('[Trigger] Attempting to start screen share...');
                
                // Проверяем что native stream готов
                if (!window.jitsiNativeMediaStream || !window.isNativeActive) {
                console.error('[Trigger] Native stream not ready');
                return { success: false, error: 'Native stream not ready' };
                }
                
                // Способ 1: APP.conference.toggleScreenSharing
                if (window.APP && window.APP.conference && window.APP.conference.toggleScreenSharing) {
                console.log('[Trigger] Using APP.conference.toggleScreenSharing');
                try {
                    await window.APP.conference.toggleScreenSharing();
                    return { success: true, method: 'APP.conference' };
                } catch (e) {
                    console.error('[Trigger] APP.conference method failed:', e);
                }
                }
                
                // Способ 2: Создание desktop трека
                if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                console.log('[Trigger] Using JitsiMeetJS.createLocalTracks');
                try {
                    const tracks = await window.JitsiMeetJS.createLocalTracks({ 
                    devices: ['desktop'],
                    desktopSharingSourceDevice: 'screen'
                    });
                    console.log('[Trigger] Created tracks:', tracks.length);
                    return { success: true, method: 'JitsiMeetJS', tracks: tracks.length };
                } catch (e) {
                    console.error('[Trigger] JitsiMeetJS method failed:', e);
                }
                }
                
                // Способ 3: Программный клик
                console.log('[Trigger] Trying button click...');
                const selectors = [
                '[aria-label*="screen" i]',
                '[aria-label*="share" i]', 
                '[aria-label*="desktop" i]',
                '[data-testid*="screen" i]',
                'button[title*="Share" i]',
                '.toolbox-button[aria-label*="screen" i]'
                ];
                
                for (const selector of selectors) {
                const button = document.querySelector(selector);
                if (button) {
                    console.log('[Trigger] Found button with selector:', selector);
                    
                    // Проверяем состояние кнопки
                    const isActive = button.classList.contains('toggled') || 
                                button.classList.contains('active') ||
                                button.getAttribute('aria-pressed') === 'true';
                    
                    if (!isActive) {
                    console.log('[Trigger] Clicking share button');
                    button.click();
                    
                    // Дополнительно эмулируем события
                    const clickEvent = new MouseEvent('click', {
                        view: window,
                        bubbles: true,
                        cancelable: true
                    });
                    button.dispatchEvent(clickEvent);
                    
                    return { success: true, method: 'button click', selector };
                    } else {
                    console.log('[Trigger] Button already active');
                    return { success: false, error: 'Already sharing' };
                    }
                }
                }
                
                console.error('[Trigger] No method worked');
                return { success: false, error: 'No method available' };
            })();
            `);
            
            log.info("Screen share trigger attempted");
            
        } catch (error: any) {
            log.error(`Failed to trigger screen share: ${error.message}`);
        }
    }

    private getScreenShareInterceptorCode(): string {
        return `
            (function() {
            console.log('[JitsiManager] Installing screen share interceptor...');
            
            let isIntercepted = false;
            let pendingSourcesCallback = null;
            
            // Ждем загрузки Jitsi API
            function waitForJitsiAPI() {
                return new Promise((resolve) => {
                let attempts = 0;
                const checkInterval = setInterval(() => {
                    attempts++;
                    
                    // Проверяем наличие JitsiMeetScreenObtainer
                    if (window.JitsiMeetScreenObtainer && 
                        typeof window.JitsiMeetScreenObtainer.openDesktopPicker === 'function') {
                    clearInterval(checkInterval);
                    console.log('[JitsiManager] JitsiMeetScreenObtainer found after', attempts, 'attempts');
                    resolve(true);
                    } else if (attempts > 100) { // Увеличиваем количество попыток
                    clearInterval(checkInterval);
                    console.error('[JitsiManager] JitsiMeetScreenObtainer not found');
                    resolve(false);
                    }
                }, 100);
                });
            }
            
            waitForJitsiAPI().then(ready => {
                if (!ready) {
                console.error('[JitsiManager] Failed to find Jitsi API');
                return;
                }
                
                // Сохраняем оригинальный метод
                const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                console.log('[JitsiManager] Original openDesktopPicker saved');
                
                // Перехватываем openDesktopPicker
                window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                console.log('[JitsiManager] ✅ Desktop picker INTERCEPTED!', options);
                
                if (isIntercepted) {
                    console.log('[JitsiManager] Already processing, skipping...');
                    return;
                }
                
                isIntercepted = true;
                pendingSourcesCallback = callback;
                
                // Запрашиваем источники через IPC
                if (window.ipcRenderer) {
                    console.log('[JitsiManager] Requesting sources via IPC...');
                    
                    window.ipcRenderer.invoke('get-desktop-sources').then(sources => {
                    console.log('[JitsiManager] Got', sources.length, 'sources from main process');
                    isIntercepted = false;
                    
                    if (sources && sources.length > 0) {
                        // Показываем диалог выбора источника
                        showSourcePicker(sources, (selectedId) => {
                        console.log('[JitsiManager] User selected source:', selectedId);
                        
                        const selectedSource = sources.find(s => s.id === selectedId);
                        
                        // Проверяем, это native источник?
                        if (selectedSource && selectedSource.isNative) {
                            console.log('[JitsiManager] 🎯 NATIVE source selected, starting native stream...');
                            
                            // Запускаем native stream
                            startNativeStreamForSource(selectedId, callback);
                        } else {
                            console.log('[JitsiManager] Standard source selected');
                            // Для обычных источников используем стандартный механизм
                            if (callback) {
                            callback(selectedId, { audio: true });
                            }
                        }
                        });
                    } else {
                        console.error('[JitsiManager] No sources received');
                        isIntercepted = false;
                        // Fallback на оригинальный метод
                        originalOpenDesktopPicker.call(this, options, callback);
                    }
                    }).catch(error => {
                    console.error('[JitsiManager] Error getting sources:', error);
                    isIntercepted = false;
                    originalOpenDesktopPicker.call(this, options, callback);
                    });
                } else {
                    console.error('[JitsiManager] ipcRenderer not available');
                    isIntercepted = false;
                    originalOpenDesktopPicker.call(this, options, callback);
                }
                };
                
                console.log('[JitsiManager] ✅ Screen share interceptor installed successfully');
            });
            
            // Функция для запуска native stream
            async function startNativeStreamForSource(sourceId, callback) {
                console.log('[JitsiManager] Starting native stream for source:', sourceId);
                
                try {
                    // ВАЖНО: Передаем sourceId в main процесс для сохранения
                    await window.ipcRenderer.invoke('jitsi:save-selected-source', sourceId);
                    
                    // Создаем native stream с захватом
                    const result = await window.ipcRenderer.invoke('create-native-stream-for-jitsi');
                    
                    if (result.success) {
                        console.log('[JitsiManager] Native stream created successfully');
                        
                        // Вызываем callback чтобы закрыть диалог
                        if (callback) {
                            callback(sourceId, { audio: true, screenShareAudio: true });
                        }
                        
                        // Ждем и запускаем демонстрацию
                        setTimeout(async () => {
                            console.log('[JitsiManager] Starting screen share...');
                            
                            // Метод 1: Redux dispatch
                            if (window.APP && window.APP.store) {
                                try {
                                    const state = window.APP.store.getState();
                                    const isSharing = state['features/base/tracks']?.some(
                                        track => track.videoType === 'desktop' && track.local
                                    );
                                    
                                    if (!isSharing) {
                                        window.APP.store.dispatch({
                                            type: 'TOGGLE_SCREENSHARING'
                                        });
                                        console.log('[JitsiManager] Dispatched TOGGLE_SCREENSHARING');
                                    }
                                } catch (e) {
                                    console.error('[JitsiManager] Redux dispatch failed:', e);
                                }
                            }
                            
                            // Метод 2: Прямой вызов createLocalTracks
                            else if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                                try {
                                    console.log('[JitsiManager] Creating desktop track...');
                                    const tracks = await window.JitsiMeetJS.createLocalTracks({ 
                                        devices: ['desktop']
                                    });
                                    console.log('[JitsiManager] Desktop track created');
                                } catch (e) {
                                    console.error('[JitsiManager] createLocalTracks failed:', e);
                                }
                            }
                        }, 1500);
                        
                    } else {
                        console.error('[JitsiManager] Failed to create native stream:', result.error);
                        if (callback) {
                            callback(sourceId, { audio: true });
                        }
                    }
                } catch (error) {
                    console.error('[JitsiManager] Error:', error);
                    if (callback) {
                        callback(sourceId, { audio: true });
                    }
                }
            }

            
            
            // Функция показа диалога выбора источника
            function showSourcePicker(sources, callback) {
                console.log('[SourcePicker] Showing picker with', sources.length, 'sources');
                
                // Удаляем предыдущий диалог если есть
                const existing = document.getElementById('source-picker-overlay');
                if (existing) existing.remove();
                
                const overlay = document.createElement('div');
                overlay.id = 'source-picker-overlay';
                overlay.style.cssText = \`
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.85);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(5px);
                \`;
                
                const dialog = document.createElement('div');
                dialog.style.cssText = \`
                background: white;
                border-radius: 16px;
                padding: 32px;
                max-width: 90%;
                max-height: 80%;
                overflow: auto;
                min-width: 700px;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                \`;
                
                let htmlContent = \`
                <h2 style="margin-top: 0; color: #333; font-size: 24px;">
                    Выберите экран или окно для демонстрации
                </h2>
                <div style="
                    display: grid; 
                    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); 
                    gap: 20px; 
                    margin: 24px 0;
                ">
                \`;
                
                sources.forEach((source, index) => {
                const isNative = source.isNative || false;
                const borderColor = isNative ? '#4CAF50' : '#2196F3';
                
                htmlContent += \`
                    <div class="source-item" data-source-id="\${source.id}" style="
                    border: 3px solid #e0e0e0;
                    border-radius: 12px;
                    padding: 16px;
                    cursor: pointer;
                    text-align: center;
                    background: white;
                    position: relative;
                    transition: all 0.3s;
                    " onmouseover="this.style.borderColor='\${borderColor}'; this.style.transform='scale(1.05)';" 
                    onmouseout="this.style.borderColor='#e0e0e0'; this.style.transform='scale(1)';">
                    \${isNative ? \`
                        <div style="
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: #4CAF50;
                        color: white;
                        padding: 4px 8px;
                        border-radius: 6px;
                        font-size: 12px;
                        font-weight: bold;
                        ">NATIVE</div>
                    \` : ''}
                    <img src="\${source.thumbnail?.dataUrl || ''}" style="
                        width: 100%; 
                        height: 160px; 
                        object-fit: contain; 
                        margin-bottom: 12px;
                        border-radius: 8px;
                        background: #f5f5f5;
                    ">
                    <div style="
                        font-size: 14px; 
                        color: #666; 
                        word-wrap: break-word;
                        font-weight: 500;
                    ">\${source.name || 'Unknown'}</div>
                    </div>
                \`;
                });
                
                htmlContent += \`
                </div>
                <div style="text-align: center; margin-top: 24px;">
                    <button id="cancel-picker-btn" style="
                    background: #f44336;
                    color: white;
                    border: none;
                    padding: 12px 32px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: 500;
                    ">Отмена</button>
                </div>
                \`;
                
                dialog.innerHTML = htmlContent;
                overlay.appendChild(dialog);
                document.body.appendChild(overlay);
                
                // Обработчики кликов
                overlay.onclick = function(e) {
                e.stopPropagation();
                
                const sourceItem = e.target.closest('.source-item');
                if (sourceItem) {
                    const sourceId = sourceItem.dataset.sourceId;
                    overlay.remove();
                    callback(sourceId);
                    return;
                }
                
                if (e.target.id === 'cancel-picker-btn' || e.target === overlay) {
                    overlay.remove();
                    return;
                }
                };
                
                // Escape для закрытия
                const handleEscape = function(e) {
                if (e.key === 'Escape') {
                    overlay.remove();
                    document.removeEventListener('keydown', handleEscape);
                }
                };
                document.addEventListener('keydown', handleEscape);
            }
            
            return { success: true };
            })();
        `;
    }

    private async cleanup(): Promise<void> {
        log.info("[STREAM-ELECTRON] >>> Starting comprehensive cleanup...");
        
        try {
            // 1. Сначала "ядерная" очистка всех потоков
            await this.nukeClearAllStreams();
            
            // 2. Ждем немного для завершения всех операций
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // 3. Останавливаем native capture
            if (this.nativeCapture && this.nativeCapture.isCapturing) {
                await this.nativeCapture.stopCapture();
            }
            
            // 4. Принудительное освобождение ресурсов
            await this.forceReleaseAllMediaResources();
            
            // 5. Очищаем callbacks
            this.nativeCapture.setFrameCallbacks(undefined, undefined);
            
            // 6. Сбрасываем состояние
            this.state.isStreamActive = false;
            this.state.streamId = null;
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            this.activeMediaStreams.clear();

            if (this.debugMonitoringInterval) {
                clearInterval(this.debugMonitoringInterval);
                this.debugMonitoringInterval = undefined;
            }
            
            log.info("[STREAM-ELECTRON] <<< Cleanup completed");
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Cleanup error: ${error.message}`);
        }
    }

    async closeWindow(): Promise<void> {
        log.info("[STREAM-ELECTRON] >>> closeWindow called");
        
        if (!this.state.window) {
            log.info("[STREAM-ELECTRON] No window to close");
            return;
        }
        
        try {
            // Сначала делаем cleanup
            await this.cleanup();
            
            // Затем закрываем окно
            if (this.state.window && !this.state.window.isDestroyed()) {
                // Удаляем все обработчики событий
                this.state.window.removeAllListeners();
                
                // Закрываем окно
                this.state.window.close();
                log.info("[STREAM-ELECTRON] Window closed");
            }
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error closing window: ${error.message}`);
            
        } finally {
            // В любом случае обнуляем ссылку на окно
            this.state.window = null;
            log.info("[STREAM-ELECTRON] <<< closeWindow completed");
        }
    }

    private createTestPattern(width: number, height: number, frameNum: number): string {
        // Этот метод больше не используется, паттерн создается прямо в Jitsi
        return "";
    }
}

export default JitsiManager;