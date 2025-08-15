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

    private activeMediaStreams: Set<string> = new Set();

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
                
                const result = await this.injectNativeStream();

                // Диагностика ПЕРЕД созданием
                log.info("[STREAM-ELECTRON] Diagnosis BEFORE create:");
                await this.diagnoseDesktopTracks();

                if (result.success) {
                    log.info("[STREAM-ELECTRON] Diagnosis AFTER create:");
                    await this.diagnoseDesktopTracks();
                }
        
                // ДИАГНОСТИКА ПОСЛЕ
                const stateAfter = await this.diagnoseJitsiState();
                log.info("[STREAM-ELECTRON] State AFTER create:", JSON.stringify(stateAfter, null, 2));
                
                return result;
                
            } catch (error: any) {
                log.error("[STREAM-ELECTRON] Error creating native stream:", error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle("jitsi:stream-stopped", async () => {
            log.info("[STREAM-ELECTRON] ===== STREAM STOPPED BY JITSI =====");
            
            // Диагностика перед остановкой
            await this.nativeCapture.debugCaptureState();
            
            // Используем принудительную остановку
            if (this.nativeCapture) {
                log.info("[STREAM-ELECTRON] Force stopping native capture...");
                const stopResult = await this.nativeCapture.forceStopCapture();
                log.info(`[STREAM-ELECTRON] Force stop result: ${JSON.stringify(stopResult)}`);
            }
            
            // Диагностика после остановки
            await this.nativeCapture.debugCaptureState();
            
            // Очищаем stream в Jitsi окне
            await this.cleanupStreamInJitsi();
            
            // Сбрасываем состояние
            this.state.isStreamActive = false;
            this.state.streamId = null;
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            log.info("[STREAM-ELECTRON] ===== CLEANUP COMPLETED =====");
            
            return { success: true };
        });

        ipcMain.handle("jitsi:stop-native-capture", async () => {
            log.info("[STREAM-ELECTRON] Stop native capture requested from monitor");
            log.info(`[STREAM-ELECTRON] Active streams to stop: ${Array.from(this.activeMediaStreams).join(', ')}`);
            
            // Диагностика ДО остановки
            log.info("[STREAM-ELECTRON] Diagnosis BEFORE stop:");
            await this.diagnoseDesktopTracks();

            // ДИАГНОСТИКА ДО ОСТАНОВКИ
            const stateBefore = await this.diagnoseJitsiState();
            log.info("[STREAM-ELECTRON] State BEFORE stop:", JSON.stringify(stateBefore, null, 2));

            try {
                // 1. НОВОЕ: Применяем ядерную очистку
                await this.nukeClearAllStreams();
                log.info("[STREAM-ELECTRON] Nuclear cleanup executed");
                
                // Небольшая задержка после ядерной очистки
                await new Promise(resolve => setTimeout(resolve, 200));

                await this.nukeClearAllStreams();
                log.info("[STREAM-ELECTRON] Nuclear cleanup executed");
                
                // НОВОЕ: Принудительное освобождение ВСЕХ медиа ресурсов
                await this.forceReleaseAllMediaResources();
                
                
                // 2. Останавливаем native capture
                if (this.nativeCapture && this.nativeCapture.isCapturing) {
                    const stopResult = await this.nativeCapture.stopCapture();
                    log.info(`[STREAM-ELECTRON] Native capture stopped: ${JSON.stringify(stopResult)}`);
                }

                // 3. НОВОЕ: Принудительная остановка через Electron API
                await this.forceStopElectronCapture();
                
                // 3. Очищаем состояние менеджера
                this.state.isStreamActive = false;
                this.state.streamId = null;
                this.state.videoFrameCount = 0;
                this.state.audioFrameCount = 0;
                
                // 4. Очищаем callbacks
                this.nativeCapture.setFrameCallbacks(undefined, undefined);
                
                // 5. Очищаем трекер streams
                this.activeMediaStreams.clear();
                log.info("[STREAM-ELECTRON] Stream tracker cleared");
                
                // 6. НОВОЕ: Принудительное освобождение desktop capture
                await this.forceReleaseDesktopCapture();
        
                // 7. Увеличиваем задержку для полного освобождения
                await new Promise(resolve => setTimeout(resolve, 500));

                await this.forceReleaseAllMediaResources();

                log.info("[STREAM-ELECTRON] Diagnosis AFTER stop:");
                await this.diagnoseDesktopTracks();

                const stateAfter = await this.diagnoseJitsiState();
                log.info("[STREAM-ELECTRON] State AFTER stop:", JSON.stringify(stateAfter, null, 2));
                
                log.info("[STREAM-ELECTRON] Complete cleanup finished");
                return { success: true };
                
            } catch (error: any) {
                log.error(`[STREAM-ELECTRON] Error stopping native capture: ${error.message}`);
                return { success: false, error: error.message };
            }
        });
    }

    async getDebugInfo(): Promise<any> {
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
            timestamp: new Date().toISOString()
        };
        
        log.info("[STREAM-ELECTRON] Debug info:", debugInfo);
        return debugInfo;
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
                            
                            // Обновляем визуальный индикатор
                            const badge = document.getElementById('electron-video-badge');
                            if (badge) {
                                badge.innerHTML = \`
                                    <div>ELECTRON VIDEO (${presetName})</div>
                                    <div>\${newSettings.width}x\${newSettings.height}@\${Math.round(newSettings.frameRate)}fps</div>
                                \`;
                                badge.style.background = newSettings.width >= 1280 ? '#4CAF50' : '#FF9800';
                            }
                            
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

        // Query параметры
        const queryParams = new URLSearchParams();
        if (options.jwt) queryParams.append('jwt', options.jwt);
        
        if (queryParams.toString()) {
        url += '?' + queryParams.toString();
        }

        // Hash параметры для конфигурации
        const hashParams = new URLSearchParams();
        hashParams.append('config.prejoinPageEnabled', 'false');
        hashParams.append('config.startWithAudioMuted', 'false');
        hashParams.append('config.startWithVideoMuted', 'true');
        
        if (options.displayName) hashParams.append('userInfo.displayName', options.displayName);
        if (options.email) hashParams.append('userInfo.email', options.email);
        if (options.avatarUrl) hashParams.append('userInfo.avatar', options.avatarUrl);
        
        if (hashParams.toString()) {
        url += '#' + hashParams.toString();
        }

        return url;
    }

    // Новый метод для базовых перехватчиков
    private async injectNativeStreamInterceptors(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        await this.state.window.webContents.executeJavaScript(`
            (function() {
                window.jitsiHandlersInjected = true;
                console.log('[JitsiNative] Injecting base interceptors...');
                
                // Сохраняем оригинальные функции
                const originalFunctions = {
                    createLocalTracks: null,
                    openDesktopPicker: null,
                    obtainDesktopStream: null,
                    getDisplayMedia: null,
                    getUserMedia: null
                };
                
                // === ПЕРЕХВАТ: JitsiMeetJS.createLocalTracks ===
                if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                    originalFunctions.createLocalTracks = window.JitsiMeetJS.createLocalTracks;
                    
                    window.JitsiMeetJS.createLocalTracks = async function(options) {
                        console.log('[JitsiNative] createLocalTracks intercepted');
                        
                        if (options && options.devices && options.devices.includes('desktop')) {
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] Using native stream');
                                
                                // Временно подменяем getUserMedia
                                const tempGetUserMedia = navigator.mediaDevices.getUserMedia;
                                navigator.mediaDevices.getUserMedia = async function(constraints) {
                                    if (constraints?.video?.mandatory?.chromeMediaSource === 'desktop') {
                                        return window.jitsiNativeMediaStream;
                                    }
                                    return tempGetUserMedia.call(this, constraints);
                                };
                                
                                const tracks = await originalFunctions.createLocalTracks.call(this, options);
                                navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                
                                return tracks;
                            }
                        }
                        
                        return originalFunctions.createLocalTracks.call(this, options);
                    };
                }
                
                // === ПЕРЕХВАТ: getDisplayMedia (глобальный) ===
                if (!window.originalGetDisplayMedia) {
                    window.originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                    
                    navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                        if (window.jitsiNativeMediaStream && window.isNativeActive) {
                            console.log('[JitsiNative] Returning native stream from getDisplayMedia');
                            return window.jitsiNativeMediaStream;
                        }
                        return window.originalGetDisplayMedia.call(this, constraints);
                    };
                }
                
                console.log('[JitsiNative] ✅ Base interceptors installed');
            })();
        `);
    }

    // Новый метод для UI элементов
    private async injectUIElements(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        await this.state.window.webContents.executeJavaScript(`
            (function() {
                // Debug индикатор
                if (!document.getElementById('stream-debug-indicator')) {
                    const debugIndicator = document.createElement('div');
                    debugIndicator.id = 'stream-debug-indicator';
                    debugIndicator.style.cssText = \`
                        position: fixed;
                        top: 10px;
                        left: 10px;
                        background: rgba(0, 0, 0, 0.8);
                        color: white;
                        padding: 10px 15px;
                        border-radius: 8px;
                        z-index: 100000;
                        font-family: monospace;
                        font-size: 12px;
                        min-width: 200px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.5);
                    \`;
                    debugIndicator.innerHTML = \`
                        <div style="font-weight: bold; margin-bottom: 5px;">🎯 Native Stream Debug</div>
                        <div>Type: <span id="source-type" style="color: #ffa726;">Not set</span></div>
                        <div>Native Active: <span id="native-status" style="color: #ef5350;">No</span></div>
                        <div>Stream ID: <span id="stream-id" style="font-size: 10px;">None</span></div>
                    \`;
                    document.body.appendChild(debugIndicator);
                }
                
                // Функция обновления индикатора
                window.updateDebugIndicator = function() {
                    const typeEl = document.getElementById('source-type');
                    const statusEl = document.getElementById('native-status');
                    const idEl = document.getElementById('stream-id');
                    const indicator = document.getElementById('stream-debug-indicator');
                    
                    if (window.jitsiNativeMediaStream && window.isNativeActive) {
                        if (typeEl) typeEl.textContent = 'NATIVE';
                        if (statusEl) {
                            statusEl.textContent = 'Active';
                            statusEl.style.color = '#66bb6a';
                        }
                        if (idEl) idEl.textContent = window.jitsiNativeMediaStream.id.substring(0, 8) + '...';
                        if (indicator) {
                            indicator.style.background = 'linear-gradient(135deg, rgba(76, 175, 80, 0.95), rgba(102, 187, 106, 0.95))';
                        }
                    } else {
                        if (typeEl) typeEl.textContent = 'None';
                        if (statusEl) {
                            statusEl.textContent = 'No';
                            statusEl.style.color = '#ef5350';
                        }
                        if (idEl) idEl.textContent = 'None';
                        if (indicator) {
                            indicator.style.background = 'rgba(0, 0, 0, 0.8)';
                        }
                    }
                };
                
                // Обновляем индикатор периодически
                setInterval(window.updateDebugIndicator, 500);
                
                // Кнопка Native Stream
                ${this.getNativeStreamButtonCode()}
                
                console.log('[JitsiNative] ✅ UI elements injected');
            })();
        `);
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

            // 1. Инжектируем базовые перехватчики для Native Stream
            await this.injectNativeStreamInterceptors();
            
            // 2. Инжектируем централизованный монитор
            const monitor = new JitsiScreenShareMonitor();
            await monitor.injectMonitor(this.state.window);
            
            // 3. Инжектируем UI элементы
            await this.injectUIElements();

            // Инжектируем перехватчик выбора источников (теперь он будет работать вместе с основным кодом)
            await this.state.window.webContents.executeJavaScript(`
                ${this.getScreenShareInterceptorCode()}
            `);

            log.info("✅ Handlers injected successfully");

        } catch (error: any) {
            log.error(`Failed to inject handlers: ${error.message}`);
        }
    }

    private getNativeStreamButtonCode(): string {
        return `
        (function() {
            const button = document.createElement('button');
            button.id = 'native-stream-button';
            button.textContent = '🎯 Start Native Stream';
            button.style.cssText = \`
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 100000;
            padding: 10px 20px;
            background: linear-gradient(135deg, #4CAF50, #66BB6A);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3);
            \`;
            
            button.onclick = async () => {
            button.disabled = true;
            button.textContent = '⏳ Starting...';
            
            try {
                const result = await window.ipcRenderer.invoke('jitsi:inject-native-stream');
                
                if (result.success) {
                button.textContent = '✅ Native Stream Active';
                button.style.background = 'linear-gradient(135deg, #66BB6A, #4CAF50)';
                } else {
                button.textContent = '❌ Failed';
                button.style.background = '#f44336';
                console.error('Failed to start native stream:', result.error);
                }
            } catch (error) {
                button.textContent = '❌ Error';
                button.style.background = '#f44336';
                console.error('Error:', error);
            }
            };
            
            document.body.appendChild(button);
        })();
        `;
    }

    private async cleanupStreamInJitsi(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[STREAM-ELECTRON] Cleaning up streams in Jitsi...');
                    
                    // Останавливаем все треки
                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => {
                            track.stop();
                            console.log('[STREAM-ELECTRON] Stopped native track:', track.kind);
                        });
                        window.jitsiNativeMediaStream = null;
                    }
                    
                    if (window.electronVideoStream) {
                        window.electronVideoStream.getTracks().forEach(track => {
                            track.stop();
                            console.log('[STREAM-ELECTRON] Stopped electron track:', track.kind);
                        });
                        window.electronVideoStream = null;
                    }
                    
                    // Закрываем audio context
                    if (window.nativeAudioContext) {
                        if (window.nativeAudioContext.state !== 'closed') {
                            window.nativeAudioContext.close();
                            console.log('[STREAM-ELECTRON] Audio context closed');
                        }
                        window.nativeAudioContext = null;
                    }
                    
                    // Очищаем буферы и флаги
                    window.leftRingBuffer = null;
                    window.rightRingBuffer = null;
                    window.isNativeActive = false;
                    window.isHybridMode = false;
                    window.audioCounter = 0;
                    window.videoFrameCounter = 0;
                    
                    // Обновляем индикатор
                    if (typeof updateDebugIndicator === 'function') {
                        updateDebugIndicator();
                    }
                    
                    console.log('[STREAM-ELECTRON] Cleanup completed');
                    return true;
                })();
            `);
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error cleaning up in Jitsi: ${error.message}`);
        }
    }

    // ===== ГЛАВНАЯ ФУНКЦИЯ =====
    async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        log.info("[STREAM-ELECTRON] === START injectNativeStream ===");

        try {
            // Останавливаем ВСЕ существующие потоки
            if (this.state.window && !this.state.window.isDestroyed()) {
                await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        // Останавливаем все video tracks от Electron
                        if (window.electronVideoStream) {
                            window.electronVideoStream.getTracks().forEach(track => {
                                track.stop();
                            });
                            window.electronVideoStream = null;
                        }
                        
                        // Останавливаем все tracks от native stream
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                track.stop();
                            });
                            window.jitsiNativeMediaStream = null;
                        }
                        
                        // Закрываем audio context
                        if (window.nativeAudioContext && window.nativeAudioContext.state !== 'closed') {
                            window.nativeAudioContext.close();
                            window.nativeAudioContext = null;
                        }
                        
                        window.isNativeActive = false;
                        window.isHybridMode = false;
                        
                        console.log('[STREAM-ELECTRON] Previous streams cleaned');
                        return true;
                    })();
                `);
            }
            
            // Останавливаем native capture если активен
            if (this.nativeCapture && this.nativeCapture.isCapturing) {
                log.warn("[STREAM-ELECTRON] ⚠️ Native capture still running, stopping it...");
                const stopResult = await this.nativeCapture.stopCapture();
                log.info(`[STREAM-ELECTRON] Stop result: ${JSON.stringify(stopResult)}`);
                
                // Ждем полной остановки
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (cleanupError: any) {
            log.error(`[STREAM-ELECTRON] Cleanup error: ${cleanupError.message}`);
        }
        
        // Сбрасываем состояние
        this.state.isStreamActive = false;
        this.state.streamId = null;
        this.state.videoFrameCount = 0;
        this.state.audioFrameCount = 0;
        
        // Ждем очистки
        await new Promise(resolve => setTimeout(resolve, 500));

        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] No active Jitsi window");
            return { success: false, error: "No active Jitsi window" };
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
        
        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        log.info(`[STREAM-ELECTRON] Using quality preset: ${qualitySettings.name}`);
        
        // ВАЖНО: Передаем список активных streams для очистки
        const activeStreamsJson = JSON.stringify(Array.from(this.activeMediaStreams));
        
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                resolve({ success: false, error: "Timeout creating stream" });
            }, 10000);
        });

        try {
            const createPromise = this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[STREAM-ELECTRON] Creating hybrid stream...');
                    console.log('[STREAM-ELECTRON] Known active streams:', ${activeStreamsJson});
                    
                    // Глобальный трекер всех streams
                    if (!window.__allMediaStreams) {
                        window.__allMediaStreams = new Map();
                    }
                    
                    // КРИТИЧНО: Останавливаем и удаляем ВСЕ известные streams из трекера
                    const stopAllKnownStreams = () => {
                        console.log('[STREAM-ELECTRON] Stopping ALL known streams...');
                        
                        // Останавливаем streams из переданного списка
                        const knownStreamIds = ${activeStreamsJson};
                        knownStreamIds.forEach(streamId => {
                            const stream = window.__allMediaStreams.get(streamId);
                            if (stream) {
                                stream.getTracks().forEach(track => {
                                    if (track.readyState === 'live') {
                                        track.stop();
                                        console.log('[STREAM-ELECTRON] Stopped tracked stream track:', track.kind, 'from stream:', streamId);
                                    }
                                });
                                // ВАЖНО: Удаляем из Map
                                window.__allMediaStreams.delete(streamId);
                            }
                        });
                        
                        // НОВОЕ: Также проверяем и останавливаем любые другие video streams в трекере
                        const allStreamIds = Array.from(window.__allMediaStreams.keys());
                        console.log('[STREAM-ELECTRON] All streams in tracker before cleanup:', allStreamIds);
                        
                        window.__allMediaStreams.forEach((stream, id) => {
                            // Проверяем, есть ли video треки (это desktop capture)
                            const videoTracks = stream.getVideoTracks();
                            if (videoTracks.length > 0) {
                                console.log('[STREAM-ELECTRON] Found orphaned video stream:', id);
                                stream.getTracks().forEach(track => {
                                    if (track.readyState === 'live') {
                                        track.stop();
                                        console.log('[STREAM-ELECTRON] Stopped orphaned track:', track.kind, track.id);
                                    }
                                });
                                // Удаляем из трекера
                                window.__allMediaStreams.delete(id);
                            }
                        });
                        
                        // Останавливаем window.electronVideoStream
                        if (window.electronVideoStream) {
                            window.electronVideoStream.getTracks().forEach(track => {
                                if (track.readyState === 'live') {
                                    track.stop();
                                    console.log('[STREAM-ELECTRON] Stopped electron video track:', track.id);
                                }
                            });
                            // Удаляем из трекера если есть
                            if (window.__allMediaStreams.has(window.electronVideoStream.id)) {
                                window.__allMediaStreams.delete(window.electronVideoStream.id);
                            }
                            window.electronVideoStream = null;
                        }
                        
                        // Останавливаем window.jitsiNativeMediaStream
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                if (track.readyState === 'live') {
                                    track.stop();
                                    console.log('[STREAM-ELECTRON] Stopped native stream track:', track.id);
                                }
                            });
                            // Удаляем из трекера если есть
                            if (window.__allMediaStreams.has(window.jitsiNativeMediaStream.id)) {
                                window.__allMediaStreams.delete(window.jitsiNativeMediaStream.id);
                            }
                            window.jitsiNativeMediaStream = null;
                        }
                        
                        console.log('[STREAM-ELECTRON] Tracker after cleanup:', Array.from(window.__allMediaStreams.keys()));
                        
                        // Закрываем audio context
                        if (window.nativeAudioContext) {
                            if (window.nativeAudioContext.state !== 'closed') {
                                window.nativeAudioContext.close();
                            }
                            window.nativeAudioContext = null;
                        }
                        
                        // Очищаем все ссылки
                        window.leftRingBuffer = null;
                        window.rightRingBuffer = null;
                        window.audioCounter = 0;
                        window.videoFrameCounter = 0;
                        window.isNativeActive = false;
                        window.isHybridMode = false;
                    };
                    
                    // Выполняем полную очистку
                    stopAllKnownStreams();
                    
                    // Ждем освобождения ресурсов
                    await new Promise(resolve => setTimeout(resolve, 300));
                    
                    try {
                        // Получаем VIDEO от Electron
                        console.log('[STREAM-ELECTRON] Requesting new video stream...');
                        
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
                        
                        if (!videoStream || videoStream.getVideoTracks().length === 0) {
                            throw new Error('Failed to get video stream');
                        }
                        
                        // ВАЖНО: Добавляем stream в трекер
                        window.__allMediaStreams.set(videoStream.id, videoStream);
                        console.log('[STREAM-ELECTRON] Added stream to tracker:', videoStream.id);
                        
                        // Сохраняем
                        window.electronVideoStream = videoStream;
                        
                        const videoTrack = videoStream.getVideoTracks()[0];
                        const actualSettings = videoTrack.getSettings();
                        console.log('[STREAM-ELECTRON] New video track created:', videoTrack.id, 'state:', videoTrack.readyState);
                        
                        // Создаем аудио контекст (код остается тот же)
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)({ 
                            sampleRate: 48000, 
                            latencyHint: 'interactive' 
                        });
                        
                        // ... остальной код создания audio context и hybrid stream ...
                        
                        // В конце, когда создаем hybrid stream:
                        const hybridStream = new MediaStream();
                        hybridStream.addTrack(videoTrack);
                        
                        // Добавляем гибридный stream в трекер
                        window.__allMediaStreams.set(hybridStream.id, hybridStream);
                        
                        // ... остальной код ...
                        
                        console.log('[STREAM-ELECTRON] ✅ Hybrid stream ready!');
                        console.log('[STREAM-ELECTRON] All tracked streams:', Array.from(window.__allMediaStreams.keys()));
                        
                        return {
                            success: true,
                            streamId: hybridStream.id,
                            videoStreamId: videoStream.id,
                            videoQuality: actualSettings.width + 'x' + actualSettings.height + '@' + Math.round(actualSettings.frameRate) + 'fps',
                            qualityPreset: '${qualitySettings.name}'
                        };
                        
                    } catch (error) {
                        console.error('[STREAM-ELECTRON] Error:', error);
                        stopAllKnownStreams();
                        return { success: false, error: error.message };
                    }
                })();
            `);

            const result = await Promise.race([createPromise, timeoutPromise]);
            
            if (result.success) {
                // ВАЖНО: Очищаем старый трекер перед добавлением новых
                this.activeMediaStreams.clear();
                
                // Добавляем новые stream IDs в трекер
                this.activeMediaStreams.add(result.streamId);
                if (result.videoStreamId) {
                    this.activeMediaStreams.add(result.videoStreamId);
                }
                
                log.info(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi SUCCESS`);
                log.info(`[STREAM-ELECTRON] Tracking streams: ${Array.from(this.activeMediaStreams).join(', ')}`);
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
        // if (!audioData || !audioData.data || audioData.source !== 'system') return;
        
        this.state.audioFrameCount++;

        if (this.state.audioFrameCount === 1) {
            log.info("[STREAM-ELECTRON] First audio frame - source:", audioData.source);
        }
        
        if (this.state.audioFrameCount === 1) {
            log.info("[STREAM-ELECTRON] >>> processNativeAudio FIRST FRAME");
        }
        
        try {
            const arrayBuffer = audioData.data;
            const samples = audioData.numSamples || 960;
            const channels = audioData.channels || 2;
            
            // Декодируем аудио
            const { leftChannel, rightChannel } = this.decodeAudioData(arrayBuffer, samples, channels);
            
            // Анализируем уровни
            const levels = this.analyzeAudioLevels(leftChannel, rightChannel);
            
            if (this.state.audioFrameCount % 50 === 0) {
                log.info(`[STREAM-ELECTRON] Audio: Frame ${this.state.audioFrameCount}, ` +
                        `L=${levels.maxLeft.toFixed(4)}, R=${levels.maxRight.toFixed(4)}`);
            }
            
            // Нормализуем
            const { processedLeft, processedRight } = this.normalizeAudio(
                leftChannel, 
                rightChannel, 
                levels
            );
            
            // Отправляем в Jitsi
            this.sendAudioToJitsi(processedLeft, processedRight, samples);
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] processNativeAudio ERROR: ${error.message}`);
        }
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
                console.log('[JitsiManager] Installing screen share picker interceptor...');
                
                // Глобальные переменные для контроля состояния
                window.__desktopPickerState = {
                    isProcessing: false,
                    lastProcessTime: 0,
                    currentStreamId: null,
                    debounceTimer: null
                };
                
                // ===== ФУНКЦИЯ ПОКАЗА ДИАЛОГА ВЫБОРА ИСТОЧНИКОВ =====
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
                            callback(null);
                            return;
                        }
                    };
                    
                    // Escape для закрытия
                    const handleEscape = function(e) {
                        if (e.key === 'Escape') {
                            overlay.remove();
                            callback(null);
                            document.removeEventListener('keydown', handleEscape);
                        }
                    };
                    document.addEventListener('keydown', handleEscape);
                }
                
                // ===== ОЖИДАНИЕ JITSI API =====
                function waitForJitsiAPI() {
                    return new Promise((resolve) => {
                        let attempts = 0;
                        const checkInterval = setInterval(() => {
                            attempts++;
                            if (window.JitsiMeetScreenObtainer && 
                                typeof window.JitsiMeetScreenObtainer.openDesktopPicker === 'function') {
                                clearInterval(checkInterval);
                                resolve(true);
                            } else if (attempts > 100) {
                                clearInterval(checkInterval);
                                resolve(false);
                            }
                        }, 100);
                    });
                }
                
                // ===== ОСНОВНАЯ ЛОГИКА ПЕРЕХВАТА =====
                waitForJitsiAPI().then(ready => {
                    if (!ready) {
                        console.log('[JitsiManager] JitsiMeetScreenObtainer not found');
                        return;
                    }
                    
                    const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                    const pickerState = window.__desktopPickerState;
                    
                    window.JitsiMeetScreenObtainer.openDesktopPicker = async function(options, callback) {
                        console.log('[JitsiManager] Desktop picker intercepted');
                        
                        // Проверка на дебаунс (игнорируем повторные вызовы в течение 2 секунд)
                        const now = Date.now();
                        if (now - pickerState.lastProcessTime < 2000) {
                            console.log('[JitsiManager] Ignoring duplicate call (debounce)');
                            if (callback) {
                                setTimeout(() => callback(null, { audio: false }), 100);
                            }
                            return;
                        }
                        
                        // Проверка на обработку
                        if (pickerState.isProcessing) {
                            console.log('[JitsiManager] Already processing, ignoring...');
                            if (callback) {
                                setTimeout(() => callback(null, { audio: false }), 100);
                            }
                            return;
                        }
                        
                        // Проверка на активный stream
                        if (window.jitsiNativeMediaStream && window.isNativeActive) {
                            console.log('[JitsiManager] Native stream already active, returning it');
                            if (callback) {
                                // Возвращаем текущий активный stream
                                callback('native-active', { audio: true, screenShareAudio: true });
                            }
                            return;
                        }
                        
                        pickerState.isProcessing = true;
                        pickerState.lastProcessTime = now;
                        
                        try {
                            // Запрашиваем источники через IPC
                            if (window.ipcRenderer) {
                                console.log('[JitsiManager] Requesting desktop sources...');
                                const sources = await window.ipcRenderer.invoke('get-desktop-sources');
                                console.log('[JitsiManager] Got', sources.length, 'sources');
                                
                                if (sources && sources.length > 0) {
                                    // Показываем диалог выбора
                                    showSourcePicker(sources, async (selectedId) => {
                                        console.log('[JitsiManager] Selected source:', selectedId);
                                        
                                        if (!selectedId) {
                                            pickerState.isProcessing = false;
                                            if (callback) callback(null, { audio: false });
                                            return;
                                        }
                                        
                                        const selectedSource = sources.find(s => s.id === selectedId);
                                        
                                        if (selectedSource && selectedSource.isNative) {
                                            console.log('[JitsiManager] Native source selected');
                                            
                                            // Проверяем, не активен ли уже stream
                                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                                console.log('[JitsiManager] Native stream already exists, reusing');
                                                pickerState.isProcessing = false;
                                                if (callback) {
                                                    callback(selectedId, { audio: true, screenShareAudio: true });
                                                }
                                                return;
                                            }
                                            
                                            // Сохраняем выбранный источник
                                            await window.ipcRenderer.invoke('jitsi:save-selected-source', selectedId);
                                            
                                            // Создаем native stream только если его нет
                                            console.log('[JitsiManager] Creating new native stream...');
                                            const result = await window.ipcRenderer.invoke('create-native-stream-for-jitsi');
                                            
                                            if (result.success) {
                                                console.log('[JitsiManager] Native stream created successfully');
                                                pickerState.currentStreamId = result.streamId;
                                                if (callback) {
                                                    callback(selectedId, { audio: true, screenShareAudio: true });
                                                }
                                            } else {
                                                console.error('[JitsiManager] Failed to create native stream:', result.error);
                                                if (callback) {
                                                    callback(null, { audio: false });
                                                }
                                            }
                                        } else {
                                            console.log('[JitsiManager] Regular Electron source selected');
                                            // Обычный источник Electron
                                            if (callback) {
                                                callback(selectedId, { audio: true });
                                            }
                                        }
                                        
                                        pickerState.isProcessing = false;
                                    });
                                } else {
                                    console.log('[JitsiManager] No sources available, falling back to original');
                                    pickerState.isProcessing = false;
                                    originalOpenDesktopPicker.call(this, options, callback);
                                }
                            } else {
                                console.log('[JitsiManager] No IPC renderer, falling back to original');
                                pickerState.isProcessing = false;
                                originalOpenDesktopPicker.call(this, options, callback);
                            }
                        } catch (error) {
                            console.error('[JitsiManager] Error in desktop picker:', error);
                            pickerState.isProcessing = false;
                            if (callback) callback(null, { audio: false });
                        }
                    };
                    
                    console.log('[JitsiManager] ✅ Screen share picker interceptor installed');
                });
                
                return { success: true };
            })();
        `;
    }

    private async cleanup(): Promise<void> {
        log.info("[STREAM-ELECTRON] >>> Starting cleanup...");
        
        try {
            // 1. Останавливаем мониторинг производительности
            if (this.performanceMonitoringInterval) {
                clearInterval(this.performanceMonitoringInterval);
                this.performanceMonitoringInterval = undefined;
                log.info("[STREAM-ELECTRON] Performance monitoring stopped");
            }
            
            // 2. Очищаем JavaScript контекст в окне Jitsi (если окно еще существует)
            if (this.state.window && !this.state.window.isDestroyed()) {
                try {
                    await this.state.window.webContents.executeJavaScript(`
                        (function() {
                            console.log('[STREAM-ELECTRON] Cleaning up JavaScript context...');
                            
                            // Останавливаем все треки
                            if (window.jitsiNativeMediaStream) {
                                window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                    track.stop();
                                    console.log('[STREAM-ELECTRON] Stopped track:', track.kind);
                                });
                            }
                            
                            if (window.electronVideoStream) {
                                window.electronVideoStream.getTracks().forEach(track => {
                                    track.stop();
                                    console.log('[STREAM-ELECTRON] Stopped electron track:', track.kind);
                                });
                            }
                            
                            // Закрываем audio context
                            if (window.nativeAudioContext) {
                                window.nativeAudioContext.close();
                                console.log('[STREAM-ELECTRON] Audio context closed');
                            }
                            
                            // Очищаем функцию cleanup если была
                            if (window.cleanupNativeStream) {
                                window.cleanupNativeStream();
                            }
                            
                            // Очищаем все глобальные переменные
                            window.jitsiNativeMediaStream = null;
                            window.electronVideoStream = null;
                            window.nativeAudioContext = null;
                            window.leftRingBuffer = null;
                            window.rightRingBuffer = null;
                            window.isNativeActive = false;
                            window.isHybridMode = false;
                            window.audioCounter = 0;
                            window.videoFrameCounter = 0;
                            window.jitsiHandlersInjected = false;
                            
                            // Удаляем визуальные индикаторы
                            const indicators = [
                                'stream-debug-indicator',
                                'electron-video-badge',
                                'native-stream-button',
                                'video-quality-badge'
                            ];
                            
                            indicators.forEach(id => {
                                const element = document.getElementById(id);
                                if (element) {
                                    element.remove();
                                    console.log('[STREAM-ELECTRON] Removed element:', id);
                                }
                            });
                            
                            console.log('[STREAM-ELECTRON] JavaScript cleanup completed');
                            return true;
                        })();
                    `);
                    
                    log.info("[STREAM-ELECTRON] JavaScript context cleaned");
                    
                } catch (error: any) {
                    log.error(`[STREAM-ELECTRON] Error cleaning JavaScript context: ${error.message}`);
                }
            }
            
            // 3. Останавливаем native capture
            if (this.nativeCapture && this.nativeCapture.isCapturing) {
                try {
                    await this.nativeCapture.stopCapture();
                    log.info("[STREAM-ELECTRON] Native capture stopped");
                } catch (error: any) {
                    log.error(`[STREAM-ELECTRON] Error stopping native capture: ${error.message}`);
                }
            }
            
            // 4. Очищаем callbacks
            this.nativeCapture.setFrameCallbacks(undefined, undefined);
            
            // 5. Сбрасываем состояние
            this.state.isStreamActive = false;
            this.state.streamId = null;
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            // НЕ обнуляем window здесь, так как это делается в closeWindow
            
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

    private async forceReleaseDesktopCapture(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            // Принудительно освобождаем ресурсы через перезагрузку части контекста
            await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[STREAM-ELECTRON] Force releasing desktop capture...');
                    
                    // Метод 1: Переопределяем getUserMedia временно
                    const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
                    navigator.mediaDevices.getUserMedia = async function(constraints) {
                        // Если запрашивается desktop, возвращаем пустой stream
                        if (constraints?.video?.mandatory?.chromeMediaSource === 'desktop') {
                            console.log('[STREAM-ELECTRON] Blocking desktop capture request');
                            throw new Error('Desktop capture blocked for cleanup');
                        }
                        return originalGetUserMedia.call(this, constraints);
                    };
                    
                    // Ждем немного
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // Восстанавливаем оригинальную функцию
                    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
                    
                    // Метод 2: Принудительный сброс через создание и удаление фейкового stream
                    try {
                        // Создаем минимальный audio stream чтобы "сбросить" состояние
                        const dummyStream = await navigator.mediaDevices.getUserMedia({ 
                            audio: { 
                                echoCancellation: false,
                                noiseSuppression: false,
                                autoGainControl: false
                            }, 
                            video: false 
                        });
                        
                        // Сразу останавливаем его
                        dummyStream.getTracks().forEach(track => track.stop());
                        console.log('[STREAM-ELECTRON] Dummy stream created and stopped');
                    } catch (e) {
                        console.log('[STREAM-ELECTRON] Could not create dummy stream:', e.message);
                    }
                    
                    // Метод 3: Сброс через garbage collection hint
                    if (typeof gc !== 'undefined') {
                        gc();
                        console.log('[STREAM-ELECTRON] Manual GC triggered');
                    }
                    
                    return true;
                })();
            `);
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Force release error: ${error.message}`);
        }
    }

    private async stopAllDesktopTracks(): Promise<number> {
        if (!this.state.window || this.state.window.isDestroyed()) return 0;
        
        try {
            const stoppedCount = await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[STREAM-ELECTRON] Searching for ALL desktop tracks...');
                    let stoppedCount = 0;
                    
                    // Хак: получаем все MediaStreamTrack через прототип
                    if (typeof MediaStreamTrack !== 'undefined') {
                        // Переопределяем метод stop для логирования
                        const originalStop = MediaStreamTrack.prototype.stop;
                        
                        // Находим все tracks через getSettings
                        const allTracks = [];
                        
                        // Проверяем все существующие MediaStream объекты
                        // Способ 1: через window объекты
                        for (let key in window) {
                            try {
                                if (window[key] instanceof MediaStream) {
                                    console.log('[STREAM-ELECTRON] Found MediaStream in window.' + key);
                                    window[key].getTracks().forEach(track => {
                                        allTracks.push({track, source: 'window.' + key});
                                    });
                                }
                            } catch (e) {}
                        }
                        
                        // Способ 2: через video элементы
                        document.querySelectorAll('video').forEach((video, idx) => {
                            if (video.srcObject instanceof MediaStream) {
                                video.srcObject.getTracks().forEach(track => {
                                    allTracks.push({track, source: 'video[' + idx + ']'});
                                });
                            }
                        });
                        
                        // Способ 3: через audio элементы  
                        document.querySelectorAll('audio').forEach((audio, idx) => {
                            if (audio.srcObject instanceof MediaStream) {
                                audio.srcObject.getTracks().forEach(track => {
                                    allTracks.push({track, source: 'audio[' + idx + ']'});
                                });
                            }
                        });
                        
                        // Проверяем и останавливаем desktop tracks
                        allTracks.forEach(({track, source}) => {
                            try {
                                const settings = track.getSettings ? track.getSettings() : {};
                                const constraints = track.getConstraints ? track.getConstraints() : {};
                                
                                // Проверяем, является ли это desktop track
                                const isDesktop = 
                                    (track.label && track.label.toLowerCase().includes('screen')) ||
                                    (track.label && track.label.toLowerCase().includes('window')) ||
                                    (settings.displaySurface) ||
                                    (constraints.video && constraints.video.mandatory && 
                                    constraints.video.mandatory.chromeMediaSource === 'desktop');
                                
                                if (isDesktop && track.readyState === 'live') {
                                    console.log('[STREAM-ELECTRON] Found desktop track:', {
                                        id: track.id,
                                        label: track.label,
                                        kind: track.kind,
                                        source: source,
                                        settings: settings
                                    });
                                    
                                    track.stop();
                                    stoppedCount++;
                                    console.log('[STREAM-ELECTRON] Stopped desktop track:', track.id);
                                }
                            } catch (e) {
                                console.error('[STREAM-ELECTRON] Error checking track:', e);
                            }
                        });
                    }
                    
                    console.log('[STREAM-ELECTRON] Total desktop tracks stopped:', stoppedCount);
                    return stoppedCount;
                })();
            `);
            
            log.info(`[STREAM-ELECTRON] Stopped ${stoppedCount} desktop tracks`);
            return stoppedCount;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error stopping desktop tracks: ${error.message}`);
            return 0;
        }
    }

    private async forceStopElectronCapture(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            // Используем Electron API для остановки всех медиа доступов
            const { session } = this.state.window.webContents;
            
            // Метод 1: Очищаем разрешения на медиа
            await session.clearStorageData({
                storages: ['cachestorage', 'websql', 'indexdb'],
                quotas: ['temporary', 'persistent', 'syncable']
            });
            
            // Метод 2: Сбрасываем разрешения для getUserMedia
            await session.setPermissionRequestHandler(null);
            
            // Метод 3: Принудительно останавливаем все медиа потоки через DevTools Protocol
            try {
                await this.state.window.webContents.debugger.attach('1.3');
                
                // Останавливаем все медиа потоки
                await this.state.window.webContents.debugger.sendCommand('Page.stopScreencast');
                
                // Отключаем debugger
                await this.state.window.webContents.debugger.detach();
            } catch (debuggerError) {
                log.warn(`[STREAM-ELECTRON] Debugger method failed: ${debuggerError}`);
            }
            
            log.info("[STREAM-ELECTRON] Forced Electron capture stop");
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error forcing stop: ${error.message}`);
        }
    }

    // Добавьте этот диагностический метод в JitsiManager
    private async diagnoseJitsiState(): Promise<any> {
        if (!this.state.window || this.state.window.isDestroyed()) return null;
        
        try {
            const state = await this.state.window.webContents.executeJavaScript(`
                (function() {
                    const state = {
                        hasConference: !!window.APP?.conference,
                        isDesktopSharingEnabled: window.APP?.conference?.isDesktopSharingEnabled?.() || false,
                        localTracks: [],
                        roomTracks: [],
                        mediaStreams: [],
                        videoElements: []
                    };
                    
                    // Проверяем локальные треки конференции
                    if (window.APP?.conference?.getLocalTracks) {
                        const tracks = window.APP.conference.getLocalTracks();
                        state.localTracks = tracks.map(t => ({
                            id: t.track?.id,
                            type: t.getType?.(),
                            videoType: t.getVideoType?.(),
                            muted: t.isMuted?.(),
                            disposed: t.disposed
                        }));
                    }
                    
                    // Проверяем треки в room
                    if (window.APP?.conference?.room) {
                        const roomTracks = window.APP.conference.room.getLocalTracks?.() || [];
                        state.roomTracks = roomTracks.map(t => ({
                            id: t.track?.id,
                            type: t.getType?.(),
                            videoType: t.getVideoType?.(),
                            disposed: t.disposed
                        }));
                    }
                    
                    // Проверяем все MediaStream объекты
                    for (let key in window) {
                        try {
                            if (window[key] instanceof MediaStream) {
                                state.mediaStreams.push({
                                    key: key,
                                    id: window[key].id,
                                    active: window[key].active,
                                    tracks: window[key].getTracks().map(t => ({
                                        id: t.id,
                                        kind: t.kind,
                                        label: t.label,
                                        readyState: t.readyState
                                    }))
                                });
                            }
                        } catch (e) {}
                    }
                    
                    // Проверяем video элементы
                    document.querySelectorAll('video').forEach((video, idx) => {
                        if (video.srcObject) {
                            state.videoElements.push({
                                index: idx,
                                streamId: video.srcObject.id,
                                active: video.srcObject.active,
                                tracks: video.srcObject.getTracks().length
                            });
                        }
                    });
                    
                    return state;
                })();
            `);
            
            return state;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Diagnose error: ${error.message}`);
            return null;
        }
    }

    private async diagnoseDesktopTracks(): Promise<any> {
        if (!this.state.window || this.state.window.isDestroyed()) return null;
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (function() {
                    const diagnosis = {
                        electronVideoStream: null,
                        jitsiNativeMediaStream: null,
                        jitsiConferenceTracks: [],
                        videoElements: [],
                        totalLiveTracks: 0
                    };
                    
                    // 1. Проверяем window.electronVideoStream
                    if (window.electronVideoStream) {
                        const tracks = window.electronVideoStream.getTracks();
                        diagnosis.electronVideoStream = {
                            exists: true,
                            tracksCount: tracks.length,
                            tracks: tracks.map(t => ({
                                id: t.id.substring(0, 8) + '...',
                                kind: t.kind,
                                state: t.readyState
                            }))
                        };
                        tracks.forEach(t => {
                            if (t.readyState === 'live') diagnosis.totalLiveTracks++;
                        });
                    }
                    
                    // 2. Проверяем window.jitsiNativeMediaStream
                    if (window.jitsiNativeMediaStream) {
                        const tracks = window.jitsiNativeMediaStream.getTracks();
                        diagnosis.jitsiNativeMediaStream = {
                            exists: true,
                            tracksCount: tracks.length,
                            tracks: tracks.map(t => ({
                                id: t.id.substring(0, 8) + '...',
                                kind: t.kind,
                                state: t.readyState
                            }))
                        };
                        tracks.forEach(t => {
                            if (t.readyState === 'live') diagnosis.totalLiveTracks++;
                        });
                    }
                    
                    // 3. Проверяем Jitsi conference tracks
                    if (window.APP?.conference) {
                        const localTracks = window.APP.conference.getLocalTracks?.() || [];
                        diagnosis.jitsiConferenceTracks = localTracks.map(jitsiTrack => ({
                            videoType: jitsiTrack.getVideoType?.(),
                            disposed: jitsiTrack.disposed,
                            trackId: jitsiTrack.track?.id?.substring(0, 8) + '...',
                            trackState: jitsiTrack.track?.readyState
                        }));
                        
                        localTracks.forEach(jitsiTrack => {
                            if (jitsiTrack.getVideoType?.() === 'desktop' && !jitsiTrack.disposed) {
                                diagnosis.totalLiveTracks++;
                            }
                        });
                    }
                    
                    // 4. Проверяем video элементы
                    document.querySelectorAll('video').forEach((video, idx) => {
                        if (video.srcObject && video.srcObject instanceof MediaStream) {
                            const tracks = video.srcObject.getTracks();
                            if (tracks.length > 0) {
                                diagnosis.videoElements.push({
                                    index: idx,
                                    streamId: video.srcObject.id.substring(0, 8) + '...',
                                    tracksCount: tracks.length,
                                    liveTracks: tracks.filter(t => t.readyState === 'live').length
                                });
                                tracks.forEach(t => {
                                    if (t.readyState === 'live' && t.kind === 'video') {
                                        diagnosis.totalLiveTracks++;
                                    }
                                });
                            }
                        }
                    });
                    
                    return diagnosis;
                })();
            `);
            
            log.info(`[STREAM-ELECTRON] DIAGNOSIS RESULT: ${JSON.stringify(result, null, 2)}`);
            return result;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Diagnose error: ${error.message}`);
            return null;
        }
    }

    private async nukeClearAllStreams(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[NUKE] === NUCLEAR CLEANUP STARTING ===');
                    
                    // Сохраняем оригинальный getUserMedia
                    const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
                    
                    // Временно блокируем getUserMedia
                    navigator.mediaDevices.getUserMedia = function() {
                        throw new Error('getUserMedia blocked during cleanup');
                    };
                    
                    try {
                        // Находим ВСЕ MediaStream объекты
                        const allStreams = [];
                        
                        // Через глобальные переменные
                        for (let key in window) {
                            try {
                                if (window[key] instanceof MediaStream) {
                                    allStreams.push(window[key]);
                                    window[key] = null; // Обнуляем ссылку
                                }
                            } catch(e) {}
                        }
                        
                        // Через video/audio элементы
                        [...document.querySelectorAll('video'), ...document.querySelectorAll('audio')].forEach(el => {
                            if (el.srcObject instanceof MediaStream) {
                                allStreams.push(el.srcObject);
                                el.srcObject = null; // Обнуляем srcObject
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
                            
                            // Обнуляем внутренние ссылки Jitsi
                            if (window.APP.conference._localTracks) {
                                window.APP.conference._localTracks = [];
                            }
                            if (window.APP.conference.localVideo) {
                                window.APP.conference.localVideo = null;
                            }
                            if (window.APP.conference.localDesktop) {
                                window.APP.conference.localDesktop = null;
                            }
                        }
                        
                    } finally {
                        // Восстанавливаем getUserMedia через небольшую задержку
                        setTimeout(() => {
                            navigator.mediaDevices.getUserMedia = originalGetUserMedia;
                            console.log('[NUKE] getUserMedia restored');
                        }, 100);
                    }
                    
                    console.log('[NUKE] === NUCLEAR CLEANUP COMPLETED ===');
                })();
            `);
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Nuke clear error: ${error.message}`);
        }
    }

    private async forceReleaseAllMediaResources(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            // 1. Используем Chrome DevTools Protocol для принудительной остановки
            const cdp = this.state.window.webContents.debugger;
            
            try {
                if (!cdp.isAttached()) {
                    await cdp.attach('1.3');
                }
                
                // Останавливаем все медиа сессии
                await cdp.sendCommand('Page.stopScreencast');
                
                // Отключаем медиа устройства
                await cdp.sendCommand('Emulation.clearDeviceMetricsOverride');
                
                // Очищаем разрешения
                await cdp.sendCommand('Browser.resetPermissions');
                
                await cdp.detach();
            } catch (cdpError) {
                log.warn(`[STREAM-ELECTRON] CDP cleanup error: ${cdpError}`);
            }
            
            // 2. Принудительно вызываем Garbage Collection
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    // Принудительно освобождаем все ссылки
                    if (typeof gc !== 'undefined') {
                        gc();
                        gc(); // Вызываем дважды для полной очистки
                        console.log('[STREAM-ELECTRON] Manual GC triggered');
                    }
                    
                    // Также пробуем через WeakRef если доступно
                    if (typeof WeakRef !== 'undefined') {
                        // Создаем слабую ссылку и сразу удаляем
                        // Это может подтолкнуть GC к более агрессивной очистке
                        let wr = new WeakRef({});
                        wr = null;
                    }
                    
                    return true;
                })();
            `);
            
            // 3. Сбрасываем медиа сессию
            const session = this.state.window.webContents.session;
            
            // Очищаем медиа разрешения
            await session.setPermissionCheckHandler(null);
            await session.setPermissionRequestHandler(null);
            
            // 4. Принудительная очистка кеша медиа устройств
            await session.clearCache();
            
            log.info("[STREAM-ELECTRON] Forced release of all media resources");
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error releasing media resources: ${error.message}`);
        }
    }
}

export default JitsiManager;