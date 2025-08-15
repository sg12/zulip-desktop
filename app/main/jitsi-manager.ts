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
    bitrate?: number;
}

// ===== КЛАСС УПРАВЛЕНИЯ КАЧЕСТВОМ =====
export class VideoQualityManager {
    private currentPreset: string = 'MEDIUM';
    private customSettings: VideoQualityPreset | null = null;
    
    constructor() {
        log.info("[VIDEO-QUALITY] Manager initialized with MEDIUM preset");
    }
    
    setPreset(presetName: keyof typeof VIDEO_QUALITY_PRESETS): VideoQualityPreset {
        if (!VIDEO_QUALITY_PRESETS[presetName]) {
            log.error(`[VIDEO-QUALITY] Unknown preset: ${presetName}`);
            return VIDEO_QUALITY_PRESETS.MEDIUM;
        }
        
        this.currentPreset = presetName;
        this.customSettings = null;
        
        const preset = VIDEO_QUALITY_PRESETS[presetName];
        log.info(`[VIDEO-QUALITY] Set preset: ${preset.name} - ${preset.description}`);
        
        return preset;
    }
    
    getCurrentSettings(): VideoQualityPreset {
        if (this.customSettings) {
            return this.customSettings;
        }
        return VIDEO_QUALITY_PRESETS[this.currentPreset];
    }
}

export const VIDEO_QUALITY_PRESETS: { [key: string]: VideoQualityPreset } = {
    ULTRA_LOW: {
        name: 'Ultra Low',
        description: '360p @ 10fps - минимальный трафик',
        width: { min: 100, max: 144 },
        height: { min: 100, max: 160 },
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
    }
};

export interface JitsiManagerConfig {
    videoQuality?: keyof typeof VIDEO_QUALITY_PRESETS;
    useHybridMode?: boolean;
    enableDebugUI?: boolean;
}

const DEFAULT_CONFIG: JitsiManagerConfig = {
    videoQuality: 'MEDIUM',
    useHybridMode: true,
    enableDebugUI: true
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
    private activeMediaStreams: Set<string> = new Set();

    constructor(
        nativeCapture: NativeCaptureManager,
        bundlePath: string,
        iconPath: string,
        config?: Partial<JitsiManagerConfig>
    ) {
        this.nativeCapture = nativeCapture;
        this.bundlePath = bundlePath;
        this.iconPath = iconPath;
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        this.videoQualityManager = new VideoQualityManager();
        if (this.config.videoQuality) {
            this.videoQualityManager.setPreset(this.config.videoQuality);
        }
        
        log.info("[JITSI-MANAGER] Initialized with config:", this.config);
        this.registerHandlers();
    }

    private registerHandlers(): void {
        // Основной обработчик для создания окна
        ipcMain.handle("jitsi:create-window", async (event, options: JitsiOptions) => {
            return this.createWindow(options);
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

        // Сохранение выбранного источника
        ipcMain.handle("jitsi:save-selected-source", async (event, sourceId: string) => {
            this.state.lastSelectedSourceId = sourceId;
            log.info(`Saved selected source: ${sourceId}`);
            return { success: true };
        });

        // Получение источников рабочего стола
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

        // Создание native stream для демонстрации экрана
        ipcMain.handle("create-native-stream-for-jitsi", async () => {
            log.info("[STREAM-ELECTRON] Create native stream requested");
            
            try {
                if (this.state.isStreamActive) {
                    log.warn("[STREAM-ELECTRON] Stream already active, resetting...");
                    await this.cleanup();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                const result = await this.injectNativeStream();
                return result;
                
            } catch (error: any) {
                log.error("[STREAM-ELECTRON] Error creating native stream:", error);
                return { success: false, error: error.message };
            }
        });

        // Остановка демонстрации экрана
        ipcMain.handle("jitsi:stop-native-capture", async () => {
            log.info("[STREAM-ELECTRON] Stop native capture requested");
            
            try {
                // Ядерная очистка всех streams
                await this.nukeClearAllStreams();
                log.info("[STREAM-ELECTRON] Nuclear cleanup executed");
                
                await new Promise(resolve => setTimeout(resolve, 200));
                
                // Останавливаем native capture
                if (this.nativeCapture && this.nativeCapture.isCapturing) {
                    const stopResult = await this.nativeCapture.stopCapture();
                    log.info(`[STREAM-ELECTRON] Native capture stopped: ${JSON.stringify(stopResult)}`);
                }
                
                // Принудительное освобождение ресурсов
                await this.forceReleaseAllMediaResources();
                
                // Очищаем состояние
                this.state.isStreamActive = false;
                this.state.streamId = null;
                this.state.videoFrameCount = 0;
                this.state.audioFrameCount = 0;
                
                // Очищаем callbacks
                this.nativeCapture.setFrameCallbacks(undefined, undefined);
                
                // Очищаем трекер streams
                this.activeMediaStreams.clear();
                log.info("[STREAM-ELECTRON] Stream tracker cleared");
                
                await new Promise(resolve => setTimeout(resolve, 500));
                
                log.info("[STREAM-ELECTRON] Complete cleanup finished");
                return { success: true };
                
            } catch (error: any) {
                log.error(`[STREAM-ELECTRON] Error stopping native capture: ${error.message}`);
                return { success: false, error: error.message };
            }
        });
    }

    async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
        try {
            // Закрываем предыдущее окно если есть
            await this.closeWindow();
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
            
            // Загружаем страницу
            await this.state.window.loadURL(conferenceUrl);
            
            // Инжектируем обработчики после загрузки
            setTimeout(() => {
                log.info("First injection attempt (3s)...");
                this.injectHandlers();
            }, 3000);
            
            setTimeout(() => {
                log.info("Second injection attempt (5s)...");
                this.injectHandlers();
            }, 5000);

            // Обработчик закрытия
            this.state.window.on('close', async (event) => {
                log.info("[STREAM-ELECTRON] Window close event triggered");
                event.preventDefault();
                await this.cleanup();
                
                if (this.state.window && !this.state.window.isDestroyed()) {
                    this.state.window.destroy();
                }
                
                this.state.window = null;
            });

            this.state.window.on('closed', () => {
                log.info("[STREAM-ELECTRON] Window closed event");
                this.state.window = null;
            });

            // Слушаем консоль для отладки
            this.state.window.webContents.on('console-message', (event, level, message) => {
                if (message.includes('[JitsiDebug]') || 
                    message.includes('[JitsiManager]') || 
                    message.includes('[NativeStream]') ||
                    message.includes('[SourcePicker]') ||
                    message.includes('[STREAM-ELECTRON]')) {
                    log.info(`Jitsi Console: ${message}`);
                }
            });

            return { success: true };

        } catch (error: any) {
            log.error(`Failed to create Jitsi window: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private buildConferenceUrl(server: string, roomName: string, options: JitsiOptions): string {
        let url = `${server}/${roomName}`;

        const queryParams = new URLSearchParams();
        if (options.jwt) queryParams.append('jwt', options.jwt);
        
        if (queryParams.toString()) {
            url += '?' + queryParams.toString();
        }

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

    private async injectHandlers(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;

        try {
            // Проверяем готовность Jitsi
            const isReady = await this.state.window.webContents.executeJavaScript(`
                (function() {
                    const ready = !!(window.JitsiMeetJS && window.APP && window.APP.conference);
                    console.log('[JitsiDebug] Checking readiness:', ready);
                    return ready;
                })();
            `);

            if (!isReady) {
                log.warn("Jitsi not ready yet, skipping injection");
                return;
            }

            // Проверяем, не инжектировали ли уже
            const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
                !!(window.jitsiHandlersInjected)
            `);

            if (alreadyInjected) {
                log.info("Handlers already injected, skipping");
                return;
            }

            // Инжектируем монитор
            const monitor = new JitsiScreenShareMonitor();
            await monitor.injectMonitor(this.state.window);
            
            // Инжектируем перехватчик выбора источников
            await this.state.window.webContents.executeJavaScript(`
                ${this.getScreenShareInterceptorCode()}
            `);

            log.info("✅ Handlers injected successfully");

        } catch (error: any) {
            log.error(`Failed to inject handlers: ${error.message}`);
        }
    }

    // ===== ГЛАВНАЯ ФУНКЦИЯ СОЗДАНИЯ ГИБРИДНОГО ПОТОКА =====
    async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        log.info("[STREAM-ELECTRON] === START injectNativeStream ===");

        try {
            // Очистка предыдущих потоков
            if (this.state.window && !this.state.window.isDestroyed()) {
                await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        if (window.electronVideoStream) {
                            window.electronVideoStream.getTracks().forEach(track => track.stop());
                            window.electronVideoStream = null;
                        }
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => track.stop());
                            window.jitsiNativeMediaStream = null;
                        }
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
                log.warn("[STREAM-ELECTRON] Native capture still running, stopping...");
                await this.nativeCapture.stopCapture();
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
        
        await new Promise(resolve => setTimeout(resolve, 500));

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

    private async startNativeAudioCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        log.info("[STREAM-ELECTRON] >>> startNativeAudioCapture");
        
        try {
            log.info("[STREAM-ELECTRON] Using optimized audio-only capture for hybrid mode");
            const result = await this.nativeCapture.startAudioOnlyCapture(sourceId);
            
            if (result.success) {
                log.info("[STREAM-ELECTRON] ✅ Audio-only capture started (CPU optimized)");
            } else {
                log.error(`[STREAM-ELECTRON] ❌ Audio-only capture failed: ${result.error}`);
            }
            
            log.info("[STREAM-ELECTRON] <<< startNativeAudioCapture");
            return result;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] <<< startNativeAudioCapture ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

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
                    
                    const sources = await window.ipcRenderer.invoke('get-desktop-sources');
                    console.log('[STREAM-ELECTRON] Got', sources.length, 'sources');
                    
                    const nativeName = '${sourceInfo.name}';
                    const nativeType = '${sourceInfo.type}';
                    
                    let matchedSource = null;
                    
                    if (nativeType === 'screen' || nativeType === 'display') {
                        matchedSource = sources.find(s => s.id.startsWith('screen:'));
                    } else if (nativeType === 'window') {
                        matchedSource = sources.find(s => {
                            if (!s.id.startsWith('window:')) return false;
                            const nameMatch = s.name && nativeName && 
                                s.name.toLowerCase().includes(nativeName.toLowerCase());
                            return nameMatch;
                        });
                        
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

    private async createHybridStreamInJitsi(electronSourceId: string): Promise<any> {
        log.info(`[STREAM-ELECTRON] >>> createHybridStreamInJitsi: ${electronSourceId}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] <<< createHybridStreamInJitsi: No window");
            return { success: false, error: "No window" };
        }
        
        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        log.info(`[STREAM-ELECTRON] Using quality preset: ${qualitySettings.name}`);
        
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
                    
                    // Останавливаем и удаляем ВСЕ известные streams из трекера
                    const stopAllKnownStreams = () => {
                        console.log('[STREAM-ELECTRON] Stopping ALL known streams...');
                        
                        const knownStreamIds = ${activeStreamsJson};
                        knownStreamIds.forEach(streamId => {
                            const stream = window.__allMediaStreams.get(streamId);
                            if (stream) {
                                stream.getTracks().forEach(track => {
                                    if (track.readyState === 'live') {
                                        track.stop();
                                    }
                                });
                                window.__allMediaStreams.delete(streamId);
                            }
                        });
                        
                        // Проверяем и останавливаем orphaned streams
                        window.__allMediaStreams.forEach((stream, id) => {
                            const videoTracks = stream.getVideoTracks();
                            if (videoTracks.length > 0) {
                                console.log('[STREAM-ELECTRON] Found orphaned video stream:', id);
                                stream.getTracks().forEach(track => {
                                    if (track.readyState === 'live') {
                                        track.stop();
                                    }
                                });
                                window.__allMediaStreams.delete(id);
                            }
                        });
                        
                        // Останавливаем старые streams
                        if (window.electronVideoStream) {
                            window.electronVideoStream.getTracks().forEach(track => {
                                if (track.readyState === 'live') {
                                    track.stop();
                                }
                            });
                            if (window.__allMediaStreams.has(window.electronVideoStream.id)) {
                                window.__allMediaStreams.delete(window.electronVideoStream.id);
                            }
                            window.electronVideoStream = null;
                        }
                        
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                if (track.readyState === 'live') {
                                    track.stop();
                                }
                            });
                            if (window.__allMediaStreams.has(window.jitsiNativeMediaStream.id)) {
                                window.__allMediaStreams.delete(window.jitsiNativeMediaStream.id);
                            }
                            window.jitsiNativeMediaStream = null;
                        }
                        
                        console.log('[STREAM-ELECTRON] Tracker after cleanup:', Array.from(window.__allMediaStreams.keys()));
                        
                        if (window.nativeAudioContext) {
                            if (window.nativeAudioContext.state !== 'closed') {
                                window.nativeAudioContext.close();
                            }
                            window.nativeAudioContext = null;
                        }
                        
                        window.leftRingBuffer = null;
                        window.rightRingBuffer = null;
                        window.audioCounter = 0;
                        window.videoFrameCounter = 0;
                        window.isNativeActive = false;
                        window.isHybridMode = false;
                    };
                    
                    // Выполняем полную очистку
                    stopAllKnownStreams();
                    
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
                        
                        // Добавляем stream в трекер
                        window.__allMediaStreams.set(videoStream.id, videoStream);
                        console.log('[STREAM-ELECTRON] Added stream to tracker:', videoStream.id);
                        
                        window.electronVideoStream = videoStream;
                        
                        const videoTrack = videoStream.getVideoTracks()[0];
                        const actualSettings = videoTrack.getSettings();
                        console.log('[STREAM-ELECTRON] New video track created:', videoTrack.id, 'state:', videoTrack.readyState);
                        
                        // Создаем аудио контекст для Native audio
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)({ 
                            sampleRate: 48000, 
                            latencyHint: 'interactive' 
                        });
                        
                        const scriptProcessor = audioContext.createScriptProcessor(2048, 0, 2);
                        
                        // RingBuffer implementation
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
                        
                        scriptProcessor.onaudioprocess = (event) => {
                            if (!window.isNativeActive) {
                                event.outputBuffer.getChannelData(0).fill(0);
                                event.outputBuffer.getChannelData(1).fill(0);
                                return;
                            }
                            leftRingBuffer.read(event.outputBuffer.getChannelData(0));
                            rightRingBuffer.read(event.outputBuffer.getChannelData(1));
                        };
                        
                        const destination = audioContext.createMediaStreamDestination();
                        scriptProcessor.connect(destination);
                        
                        // Создаем гибридный поток
                        const hybridStream = new MediaStream();
                        hybridStream.addTrack(videoTrack);
                        
                        if (destination.stream.getAudioTracks().length > 0) {
                            hybridStream.addTrack(destination.stream.getAudioTracks()[0]);
                        }
                        
                        // Добавляем гибридный stream в трекер
                        window.__allMediaStreams.set(hybridStream.id, hybridStream);
                        
                        // Сохраняем все
                        window.jitsiNativeMediaStream = hybridStream;
                        window.leftRingBuffer = leftRingBuffer;
                        window.rightRingBuffer = rightRingBuffer;
                        window.nativeAudioContext = audioContext;
                        window.isNativeActive = true;
                        window.isHybridMode = true;
                        window.audioCounter = 0;
                        
                        if (audioContext.state === 'suspended') {
                            await audioContext.resume();
                        }
                        
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
                // Очищаем старый трекер перед добавлением новых
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

    private processNativeAudio(audioData: any): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        this.state.audioFrameCount++;

        if (this.state.audioFrameCount === 1) {
            log.info("[STREAM-ELECTRON] First audio frame - source:", audioData.source);
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

    private decodeAudioData(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): { leftChannel: Float32Array; rightChannel: Float32Array } {
        
        let leftChannel = new Float32Array(samples);
        let rightChannel = new Float32Array(samples);
        
        if (arrayBuffer.byteLength === samples * channels * 4) {
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

    private getScreenShareInterceptorCode(): string {
        return `
            (function() {
                console.log('[JitsiManager] Installing screen share picker interceptor...');
                
                window.__desktopPickerState = {
                    isProcessing: false,
                    lastProcessTime: 0,
                    currentStreamId: null,
                    debounceTimer: null
                };
                
                // Функция показа диалога выбора источников
                function showSourcePicker(sources, callback) {
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
                
                // Ожидание Jitsi API
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
                
                // Основная логика перехвата
                waitForJitsiAPI().then(ready => {
                    if (!ready) {
                        console.log('[JitsiManager] JitsiMeetScreenObtainer not found');
                        return;
                    }
                    
                    const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                    const pickerState = window.__desktopPickerState;
                    
                    window.JitsiMeetScreenObtainer.openDesktopPicker = async function(options, callback) {
                        console.log('[JitsiManager] Desktop picker intercepted');
                        
                        // Проверка на дебаунс
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
                                            
                                            // Создаем native stream
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
                
                window.jitsiHandlersInjected = true;
                return { success: true };
            })();
        `;
    }

    private async cleanup(): Promise<void> {
        log.info("[STREAM-ELECTRON] >>> Starting cleanup...");
        
        try {
            // Очищаем JavaScript контекст в окне Jitsi
            if (this.state.window && !this.state.window.isDestroyed()) {
                try {
                    await this.state.window.webContents.executeJavaScript(`
                        (function() {
                            console.log('[STREAM-ELECTRON] Cleaning up JavaScript context...');
                            
                            // Останавливаем все треки
                            if (window.jitsiNativeMediaStream) {
                                window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                    track.stop();
                                });
                            }
                            
                            if (window.electronVideoStream) {
                                window.electronVideoStream.getTracks().forEach(track => {
                                    track.stop();
                                });
                            }
                            
                            // Закрываем audio context
                            if (window.nativeAudioContext) {
                                window.nativeAudioContext.close();
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
                            
                            console.log('[STREAM-ELECTRON] JavaScript cleanup completed');
                            return true;
                        })();
                    `);
                    
                    log.info("[STREAM-ELECTRON] JavaScript context cleaned");
                    
                } catch (error: any) {
                    log.error(`[STREAM-ELECTRON] Error cleaning JavaScript context: ${error.message}`);
                }
            }
            
            // Останавливаем native capture
            if (this.nativeCapture && this.nativeCapture.isCapturing) {
                try {
                    await this.nativeCapture.stopCapture();
                    log.info("[STREAM-ELECTRON] Native capture stopped");
                } catch (error: any) {
                    log.error(`[STREAM-ELECTRON] Error stopping native capture: ${error.message}`);
                }
            }
            
            // Очищаем callbacks
            this.nativeCapture.setFrameCallbacks(undefined, undefined);
            
            // Сбрасываем состояние
            this.state.isStreamActive = false;
            this.state.streamId = null;
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
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
                this.state.window.removeAllListeners();
                this.state.window.close();
                log.info("[STREAM-ELECTRON] Window closed");
            }
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] Error closing window: ${error.message}`);
            
        } finally {
            this.state.window = null;
            log.info("[STREAM-ELECTRON] <<< closeWindow completed");
        }
    }

    // Вспомогательные методы для очистки при остановке демонстрации
    private async nukeClearAllStreams(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[NUKE] === NUCLEAR CLEANUP STARTING ===');
                    
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
           // Используем Chrome DevTools Protocol для принудительной остановки
           const cdp = this.state.window.webContents.debugger;
           
           try {
               if (!cdp.isAttached()) {
                   await cdp.attach('1.3');
               }
               
               // Останавливаем все медиа сессии
               await cdp.sendCommand('Page.stopScreencast');
               await cdp.sendCommand('Emulation.clearDeviceMetricsOverride');
               await cdp.sendCommand('Browser.resetPermissions');
               
               await cdp.detach();
           } catch (cdpError) {
               log.warn(`[STREAM-ELECTRON] CDP cleanup error: ${cdpError}`);
           }
           
           // Принудительно вызываем Garbage Collection
           await this.state.window.webContents.executeJavaScript(`
               (function() {
                   if (typeof gc !== 'undefined') {
                       gc();
                       gc(); // Вызываем дважды для полной очистки
                       console.log('[STREAM-ELECTRON] Manual GC triggered');
                   }
                   
                   if (typeof WeakRef !== 'undefined') {
                       let wr = new WeakRef({});
                       wr = null;
                   }
                   
                   return true;
               })();
           `);
           
           // Сбрасываем медиа сессию
           const session = this.state.window.webContents.session;
           
           await session.setPermissionCheckHandler(null);
           await session.setPermissionRequestHandler(null);
           
           // Принудительная очистка кеша медиа устройств
           await session.clearCache();
           
           log.info("[STREAM-ELECTRON] Forced release of all media resources");
           
       } catch (error: any) {
           log.error(`[STREAM-ELECTRON] Error releasing media resources: ${error.message}`);
       }
   }
}

export default JitsiManager;