// jitsi-native-manager.ts - Управление Jitsi-окном с поддержкой нативного захвата ИЛИ виртуального аудиокабеля
import { BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import log from "electron-log";
import { NativeCaptureManager } from "./native-capture";
import { JitsiScreenShareMonitor } from "./jitsi-screen-share-monitor";
import { 
    VideoQualityManager, 
    VIDEO_QUALITY_PRESETS,
    getApplyQualityPresetCode
} from "./video-quality-manager";
import {
    AudioProcessor,
    getRingBufferCode,
    getSendAudioToJitsiCode
} from "./audio-processor";
import { JitsiUIManager } from "./jitsi-ui-manager";
import { JitsiWindowUtils } from "./jitsi-window-utils";
import { JitsiOptions, JitsiState, JitsiManagerConfig } from './jitsi-types';
import { JitsiURLBuilder } from './jitsi-url-builder';
import { getSimplifiedScreenShareInterceptorCode } from "./electron-custom-source-picker";
import { AudioSessionService } from "./services/audioSessionService.js";

const DEFAULT_CONFIG: JitsiManagerConfig = {
    videoQuality: 'MEDIUM',
    enableDebugUI: true,
    enablePerformanceMonitoring: false,
    monitoringInterval: 5000
};

export class JitsiNativeManager {
    private state: JitsiState = {
        window: null,
        isStreamActive: false,
        streamId: null,
        lastSelectedSourceName: null
    };
    private nativeCapture: NativeCaptureManager;
    private bundlePath: string;
    private iconPath: string;
    private config: JitsiManagerConfig;
    private videoQualityManager: VideoQualityManager;
    private audioProcessor: AudioProcessor;
    private uiManager: JitsiUIManager;
    private jitsiUtils: JitsiWindowUtils;
    private screenShareMonitor: JitsiScreenShareMonitor;
    private activeMediaStreams: Set<string> = new Set(); 
    private debugMonitoringInterval?: NodeJS.Timer;
    private useVirtualCableMode: boolean = false; // 🆕 Флаг режима Virtual Cable
    private routedProcessName: string | null = null; // 🆕 Имя процесса, звук которого перенаправлен на VC
    private audioSessionService: AudioSessionService; // 🆕 Сервис для работы с SoundVolumeView

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
        this.audioProcessor = new AudioProcessor();
        this.uiManager = new JitsiUIManager();
        this.jitsiUtils = new JitsiWindowUtils();
        this.audioSessionService = new AudioSessionService();
        if (this.config.videoQuality) {
            this.videoQualityManager.setPreset(this.config.videoQuality);
        }
        log.info("[JITSI-NATIVE-MANAGER] Initialized with config:", this.config);
        this.registerHandlers();
        this.screenShareMonitor = new JitsiScreenShareMonitor();
    }

    // 🆕 Метод для включения режима Virtual Cable
    enableVirtualCableMode(enable: boolean): void {
        this.useVirtualCableMode = enable;
        log.info(`[JITSI-NATIVE-MANAGER] Virtual Cable mode: ${enable ? 'ENABLED' : 'DISABLED'}`);
    }

    // 🆕 Геттер для проверки режима Virtual Cable
    isVirtualCableMode(): boolean {
        return this.useVirtualCableMode;
    }

    private registerHandlers(): void {
        ipcMain.handle("jitsi:create-window", async (event, options: JitsiOptions) => {
            return this.createWindow(options);
        });
        ipcMain.handle("jitsi:inject-native-stream", async () => {
            return this.injectNativeStream();
        });
        ipcMain.handle("jitsi:close", async () => {
            return this.closeWindow();
        });
        ipcMain.handle("jitsi:get-status", async () => {
            return {
                hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
                isStreamActive: this.state.isStreamActive,
                streamId: this.state.streamId,
                useVirtualCable: this.useVirtualCableMode
            };
        });
        ipcMain.handle("jitsi:save-selected-source", async (event, sourceId: string, sourceName?: string) => {
            this.state.lastSelectedSourceId = sourceId;
            this.state.lastSelectedSourceName = sourceName || null;
            log.info(`[VC-MODE] Saved selected source: ${sourceId} (${sourceName || 'unknown'})`);
            
            // Если Virtual Cable включён, попробуем найти и маршрутизировать аудио
            if (this.useVirtualCableMode && sourceName) {
                await this.tryAutoRouteAudio(sourceName);
            }
            
            return { success: true };
        });
        // 🆕 Обработчики для перенаправления звука приложения
        ipcMain.handle("jitsi:route-app-audio-to-cable", async (event, processName: string) => {
            return await this.routeAppAudioToCable(processName);
        });
        ipcMain.handle("jitsi:restore-app-audio", async (event, processName: string) => {
            return await this.restoreAppAudio(processName);
        });
        ipcMain.handle("jitsi:get-config", async () => {
            return this.getConfig();
        });
        ipcMain.handle("jitsi:update-config", async (event, newConfig: Partial<JitsiManagerConfig>) => {
            try {
                this.updateConfig(newConfig);
                return { success: true, config: this.getConfig() };
            } catch (error: any) {
                log.error("[JITSI-NATIVE-MANAGER] Failed to update config:", error);
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
                }))
            };
        });
        ipcMain.handle("jitsi:change-video-quality", async (event, quality: keyof typeof VIDEO_QUALITY_PRESETS) => {
            return this.changeVideoQuality(quality);
        });
        ipcMain.handle("jitsi:set-custom-quality", async (event, width: number, height: number, fps: number) => {
            return this.setCustomVideoQuality(width, height, fps);
        });
        ipcMain.handle("jitsi:get-debug-info", async () => {
            return this.getDebugInfo();
        });
        ipcMain.handle("create-native-stream-for-jitsi", async () => {
            log.info("[JITSI-NATIVE-MANAGER] Create native stream requested");
            try {
                if (this.state.isStreamActive) {
                    log.warn("[JITSI-NATIVE-MANAGER] Stream already active, resetting...");
                    await this.cleanup();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                return await this.injectNativeStream();
            } catch (error: any) {
                log.error("[JITSI-NATIVE-MANAGER] Error creating native stream:", error);
                return { success: false, error: error.message };
            }
        });
        ipcMain.handle("jitsi:conference-left", async () => {
            log.info("[JITSI-NATIVE-MANAGER] Conference left event received");
            
            // 🆕 Восстанавливаем аудио при выходе из конференции
            await this.restoreRoutedAudio();
            
            if (this.state.window && !this.state.window.isDestroyed()) {
                await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        window.__interceptorFlag = false;
                        window.isScreenShareActive = false;
                        window.isNativeActive = false;
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(t => t.stop());
                            window.jitsiNativeMediaStream = null;
                        }
                        console.log('[JITSI-NATIVE-MANAGER] All flags reset on conference leave');
                    })();
                `);
            }
            setTimeout(async () => {
                log.info("[JITSI-NATIVE-MANAGER] Closing window after conference leave");
                await this.closeWindow();
            }, 1000);
            return { success: true };
        });
        ipcMain.handle("jitsi:stop-native-capture", async () => {
            log.info("[JITSI-NATIVE-MANAGER] Stop native capture requested");
            try {
                // 🆕 Восстанавливаем аудио при остановке демонстрации
                await this.restoreRoutedAudio();
                
                if(this.state.window){
                    await JitsiWindowUtils.nukeClearAllStreams(this.state.window);
                    if (this.nativeCapture && this.nativeCapture.isCapturing) {
                        const stopResult = await this.nativeCapture.stopCapture();
                        log.info(`[JITSI-NATIVE-MANAGER] Native capture stopped: ${JSON.stringify(stopResult)}`);
                    }
                    await JitsiWindowUtils.forceReleaseAllMediaResources(this.state.window);
                    this.state.isStreamActive = false;
                    this.state.streamId = null;
                    this.state.videoFrameCount = 0;
                    this.state.audioFrameCount = 0;
                    this.nativeCapture.setFrameCallbacks(undefined, undefined);
                    this.activeMediaStreams.clear();
                }
                return { success: true };
            } catch (error: any) {
                log.error(`[JITSI-NATIVE-MANAGER] Error stopping: ${error.message}`);
                return { success: false, error: error.message };
            }
        });
        ipcMain.handle("get-electron-desktop-sources", async () => {
            const { desktopCapturer } = require('electron');
            const sources = await desktopCapturer.getSources({
                types: ['window', 'screen'],
                thumbnailSize: { width: 200, height: 140 }
            });
            return sources.map((s: any) => ({
                id: s.id,
                name: s.name,
                display_id: s.display_id,
                thumbnail: s.thumbnail.resize({ width: 200 }).toDataURL('image/jpeg', 0.7)
            }));
        });
        ipcMain.handle("jitsi:screen-share-stopped", async () => {
            log.info("[JITSI-NATIVE-MANAGER] Screen share stopped event received");
            
            // 🆕 Восстанавливаем аудио при остановке screen share
            await this.restoreRoutedAudio();
            
            this.state.isStreamActive = false;
            this.state.streamId = null;
            if (this.nativeCapture && this.nativeCapture.isCapturing) {
                await this.nativeCapture.stopCapture();
            }
            if (this.state.window && !this.state.window.isDestroyed()) {
                await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        window.isScreenShareActive = false;
                        window.isNativeActive = false;
                        window.__interceptorFlag = false;
                        console.log('[JITSI-NATIVE-MANAGER] Screen share flags reset');
                    })();
                `);
            }
            return { success: true };
        });

        // 🆕 IPC обработчик для ручного восстановления аудио
        ipcMain.handle("jitsi:restore-all-audio", async () => {
            log.info("[JITSI-NATIVE-MANAGER] Manual audio restore requested");
            return await this.restoreRoutedAudio();
        });
    }

    updateConfig(newConfig: Partial<JitsiManagerConfig>): void {
        log.info("[JITSI-NATIVE-MANAGER] Updating config:", newConfig);
        const oldConfig = { ...this.config };
        this.config = { ...this.config, ...newConfig };
        if (newConfig.videoQuality && newConfig.videoQuality !== oldConfig.videoQuality) {
            this.videoQualityManager.setPreset(newConfig.videoQuality);
            if (this.state.isStreamActive) {
                this.changeVideoQuality(newConfig.videoQuality).catch(err => {
                    log.error("[JITSI-NATIVE-MANAGER] Failed to apply video quality:", err);
                });
            }
        }
    }

    getConfig(): JitsiManagerConfig {
        return { ...this.config };
    }

    async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
        try {
            await this.closeWindow();
            await new Promise(resolve => setTimeout(resolve, 500));
            const server = options.serverUrl || 'https://jitsi-connectrm.ru';
            const roomName = options.roomName.replace(/[^a-zA-Z0-9-_]/g, '');
            const displayName = options.displayName || 'Guest';
            const topic = options.topic || '';
            const stream = options.stream || '';
            log.info(`Creating Jitsi window: ${server}/${roomName}`);
            this.state.window = new BrowserWindow({
                width: 1200,
                height: 800,
                minWidth: 800,
                minHeight: 600,
                title: `Трансляция: ${stream} - ${topic}`,
                icon: this.iconPath,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: false,
                    webSecurity: false,
                    partition: `jitsi-${Date.now()}`,
                    preload: path.join(this.bundlePath, "preload.js")
                },
                backgroundColor: '#000000',
                show: true,
                paintWhenInitiallyHidden: true,
                center: true
            });
            this.state.window.on('page-title-updated', (event) => {
                event.preventDefault();
            });
            await this.uiManager.injectLoadingScreen(this.state.window);
            this.state.window.show();
            this.state.window.webContents.on('did-start-loading', () => {
                this.state.window?.webContents.insertCSS(`
                    html, body {
                        background: #1a1a2e !important;
                        transition: opacity 0.3s ease-in-out;
                    }
                    body > * {
                        opacity: 0;
                        animation: fadeIn 0.5s ease-in-out 0.5s forwards;
                    }
                    @keyframes fadeIn {
                        to { opacity: 1; }
                    }
                    
                    /* 🎬 Чёрный фон для видео вместо зелёного при нестандартных размерах */
                    video {
                        background-color: #000000 !important;
                        object-fit: contain !important;
                        /* Дополнительно: box-shadow для скрытия артефактов по краям */
                        box-shadow: inset 0 0 0 1px #000000;
                    }
                    
                    /* Контейнеры видео тоже чёрные - АГРЕССИВНЫЙ СЕЛЕКТОР */
                    .videocontainer,
                    .videocontainer__background,
                    .large-video-background,
                    .filmstrip__videos,
                    .filmstrip,
                    #largeVideoContainer,
                    #localVideoContainer,
                    #remoteVideos,
                    #videospace,
                    #localVideoWrapper,
                    #localVideoTileViewContainer,
                    .video-thumbnail,
                    .avatar-container,
                    .participant-avatar,
                    [class*="video"],
                    [class*="Video"],
                    [id*="video"],
                    [id*="Video"],
                    div[style*="green"],
                    div[style*="rgb(0, 128, 0)"],
                    div[style*="rgb(0, 255, 0)"] {
                        background-color: #000000 !important;
                        background: #000000 !important;
                    }
                    
                    /* Убираем возможный зелёный артефакт с canvas */
                    canvas {
                        background-color: #000000 !important;
                        background: #000000 !important;
                    }
                    
                    /* Убираем зелёный с любого элемента с явным зелёным цветом */
                    *[style*="background-color: green"],
                    *[style*="background: green"],
                    *[style*="#00ff00"],
                    *[style*="#008000"] {
                        background-color: #000000 !important;
                        background: #000000 !important;
                    }
                `);
            });
            const conferenceUrl = JitsiURLBuilder.buildConferenceUrl(server, roomName, options);
            log.info(`Loading conference URL: ${conferenceUrl}`);
            this.state.window.webContents.on('did-finish-load', async () => {
                log.info("[JITSI-NATIVE-MANAGER] Page loaded, injecting handlers...");
                
                // 🎨 Инъекция скрипта для борьбы с зелёным фоном
                await this.state.window?.webContents.executeJavaScript(`
                    (function() {
                        console.log('[GREEN-FIX] Starting green background fix...');
                        
                        // Функция для замены зелёного на чёрный
                        function fixGreenBackgrounds() {
                            const allElements = document.querySelectorAll('*');
                            let fixedCount = 0;
                            
                            allElements.forEach(el => {
                                const style = window.getComputedStyle(el);
                                const bgColor = style.backgroundColor;
                                
                                // Проверяем на зелёный цвет (rgb(0, 128, 0), rgb(0, 255, 0), etc.)
                                if (bgColor && (
                                    bgColor.includes('rgb(0, 128, 0)') ||
                                    bgColor.includes('rgb(0, 255, 0)') ||
                                    bgColor.includes('rgb(0, 200') ||
                                    bgColor.includes('rgb(0, 150')
                                )) {
                                    el.style.backgroundColor = '#000000';
                                    fixedCount++;
                                }
                            });
                            
                            if (fixedCount > 0) {
                                console.log('[GREEN-FIX] Fixed ' + fixedCount + ' green elements');
                            }
                        }
                        
                        // Запускаем сразу и потом периодически
                        fixGreenBackgrounds();
                        setInterval(fixGreenBackgrounds, 2000);
                        
                        // Также следим за изменениями DOM
                        const observer = new MutationObserver(() => {
                            fixGreenBackgrounds();
                        });
                        observer.observe(document.body, { childList: true, subtree: true });
                        
                        console.log('[GREEN-FIX] Green fix observer installed');
                    })();
                `);
                if (this.state.window) {
                    await this.uiManager.waitForJitsiReady(this.state.window);
                    await this.uiManager.hideLoadingScreen(this.state.window);
                    setTimeout(async () => {
                        if (this.state.window) {
                            await this.uiManager.injectDebugOverlay(
                                this.state.window,
                                this.config,
                                this.nativeCapture && this.nativeCapture.isNativeAvailable(),
                                false,
                                this.useVirtualCableMode,
                                () => this.getDebugInfo()
                            );
                            await this.startDebugMonitoring();
                        }
                    }, 500);
                }
            });
            await this.state.window.loadURL(conferenceUrl);
            setTimeout(() => this.injectHandlers(), 3000);
            setTimeout(() => this.injectHandlers(), 5000);
            setTimeout(() => this.injectHandlers(), 8000);

            this.state.window.on('close', async (event) => {
                log.info("[JITSI-NATIVE-MANAGER] Window close event triggered");
                event.preventDefault();
                if(this.state.window){
                    const left = await JitsiWindowUtils.leaveConference(this.state.window);
                    if (left) {
                        log.info("[JITSI-NATIVE-MANAGER] Successfully left conference");
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                await this.cleanup();
                if (this.state.window && !this.state.window.isDestroyed()) {
                    this.state.window.destroy();
                }
                this.state.window = null;
            });

            this.state.window.on('closed', () => {
                log.info("[JITSI-NATIVE-MANAGER] Window closed event");
                this.state.window = null;
            });

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

    private async injectHandlers(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        try {
            const isReady = await this.state.window.webContents.executeJavaScript(`
                !!(window.JitsiMeetJS && window.APP && window.APP.conference)
            `);
            if (!isReady) {
                log.warn("Jitsi not ready yet, skipping injection");
                return;
            }

            const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
                !!(window.jitsiHandlersInjected)
            `);
            if (alreadyInjected) return;

            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    if (window.jitsiHandlersInjected) {
                        console.log('[JitsiNative] Handlers already injected');
                        return;
                    }
                    window.jitsiHandlersInjected = true;
                    
                    console.log('[JitsiNative] Starting complete injection...');
                    
                    const originalFunctions = {
                        openDesktopPicker: null,
                        obtainDesktopStream: null,
                        createLocalTracks: null,
                        getDisplayMedia: null,
                        getUserMedia: null
                    };
                    
                    // Перехват JitsiMeetJS.createLocalTracks
                    if (window.JitsiMeetJS && window.JitsiMeetJS.createLocalTracks) {
                        console.log('[JitsiNative] Saving original createLocalTracks');
                        originalFunctions.createLocalTracks = window.JitsiMeetJS.createLocalTracks;
                        
                        window.JitsiMeetJS.createLocalTracks = async function(options) {
                            console.log('[JitsiNative] createLocalTracks intercepted, options:', options);
                            
                            let savedMic = null;
                            try {
                                const currentTracks = window.APP?.conference?.getLocalTracks?.() || [];
                                savedMic = currentTracks.find(t => t.type === 'audio' && t.videoType !== 'desktop');
                            } catch (e) {}

                            if (options && options.devices && options.devices.includes('desktop')) {
                                console.log('[JitsiNative] Desktop track requested');
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] Native stream available, injecting it...');
                                    
                                    try {
                                        const tempGetUserMedia = navigator.mediaDevices.getUserMedia;
                                        const tempGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                                        
                                        navigator.mediaDevices.getUserMedia = async function(constraints) {
                                            if (window.__creatingHybridStream) {
                                                return originalFunctions.getUserMedia.call(this, constraints);
                                            }
                                            if (constraints && constraints.video && 
                                                constraints.video.mandatory && 
                                                constraints.video.mandatory.chromeMediaSource === 'desktop') {
                                                console.log('[JitsiNative] Returning native stream for desktop getUserMedia');
                                                return window.jitsiNativeMediaStream;
                                            }
                                            return tempGetUserMedia.call(this, constraints);
                                        };
                                        
                                        navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                                            console.log('[JitsiNative] RETURNING NATIVE STREAM!');
                                            return window.jitsiNativeMediaStream;
                                        };
                                        
                                        const tracks = await originalFunctions.createLocalTracks.call(this, options);
                                        
                                        navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                        navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                        
                                        if (tracks && tracks.length > 0) {
                                            console.log('[JitsiNative] JitsiLocalTrack created successfully');
                                            
                                            setTimeout(async () => {
                                                if (savedMic && !savedMic.isDisposed()) {
                                                    try {
                                                        const current = window.APP?.conference?.getLocalTracks?.() || [];
                                                        const hasMic = current.some(t => 
                                                            t.type === 'audio' && 
                                                            t.videoType !== 'desktop'
                                                        );
                                                        
                                                        if (!hasMic) {
                                                            console.log('[JitsiNative] Re-adding microphone after desktop track');
                                                            await window.APP.conference.addTrack(savedMic);
                                                        }
                                                    } catch (e) {
                                                        console.error('[JitsiNative] Failed to restore mic:', e);
                                                    }
                                                }
                                            }, 500);

                                            const originalDispose = tracks[0].dispose;
                                            tracks[0].dispose = function() {
                                                console.log('[JitsiNative] Track dispose called');
                                                window.isNativeActive = false;
                                                if (originalDispose) {
                                                    return originalDispose.call(this);
                                                }
                                            };
                                        }
                                        
                                        return tracks;
                                        
                                    } catch (e) {
                                        console.error('[JitsiNative] Error in createLocalTracks:', e);
                                        throw e;
                                    }
                                }
                            }
                            
                            return originalFunctions.createLocalTracks.call(this, options);
                        };
                        
                        console.log('[JitsiNative] createLocalTracks intercepted');
                    }
                    
                    // Перехват JitsiMeetScreenObtainer
                    if (window.JitsiMeetScreenObtainer) {
                        console.log('[JitsiNative] Setting up JitsiMeetScreenObtainer interceptors');
                        
                        if (window.JitsiMeetScreenObtainer.openDesktopPicker) {
                            originalFunctions.openDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                            
                            window.JitsiMeetScreenObtainer.openDesktopPicker = function(options, callback) {
                                console.log('[JitsiNative] openDesktopPicker intercepted');
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] Native stream active, auto-selecting');
                                    setTimeout(() => {
                                        const sourceId = 'native:stream:' + Date.now();
                                        callback(sourceId, { audio: true, screenShareAudio: true });
                                    }, 100);
                                    return;
                                }
                                
                                console.log('[JitsiNative] No native stream, letting main interceptor handle');
                            };
                        }
                        
                        if (window.JitsiMeetScreenObtainer.obtainDesktopStream) {
                            originalFunctions.obtainDesktopStream = window.JitsiMeetScreenObtainer.obtainDesktopStream;
                            
                            window.JitsiMeetScreenObtainer.obtainDesktopStream = function(sourceId, callback, errorCallback) {
                                console.log('[JitsiNative] obtainDesktopStream intercepted');
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] Returning native stream');
                                    setTimeout(() => {
                                        callback(window.jitsiNativeMediaStream);
                                    }, 100);
                                    return;
                                }
                                
                                return originalFunctions.obtainDesktopStream.call(this, sourceId, callback, errorCallback);
                            };
                        }
                        
                        console.log('[JitsiNative] JitsiMeetScreenObtainer intercepted');
                    }
                    
                    // Глобальные перехваты
                    if (!window.originalGetDisplayMedia) {
                        originalFunctions.getDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                        window.originalGetDisplayMedia = originalFunctions.getDisplayMedia;
                        
                        navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                            console.log('[JitsiNative] Global getDisplayMedia intercepted');
                            
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] Returning native stream');
                                return window.jitsiNativeMediaStream;
                            }
                            
                            return originalFunctions.getDisplayMedia.call(this, constraints);
                        };
                    }
                    
                    if (!window.originalGetUserMedia) {
                        originalFunctions.getUserMedia = navigator.mediaDevices.getUserMedia;
                        window.originalGetUserMedia = originalFunctions.getUserMedia;
                        
                        navigator.mediaDevices.getUserMedia = async function(constraints) {
                            if (constraints && constraints.video && 
                                constraints.video.mandatory && 
                                constraints.video.mandatory.chromeMediaSource === 'desktop') {
                                console.log('[JitsiNative] Global getUserMedia for desktop intercepted');
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] Returning native stream');
                                    return window.jitsiNativeMediaStream;
                                }
                            }
                            
                            return originalFunctions.getUserMedia.call(this, constraints);
                        };
                    }
                    
                    console.log('[JitsiNative] Complete injection finished!');
                    return true;
                })();
            `);

            await this.state.window.webContents.executeJavaScript(getSimplifiedScreenShareInterceptorCode());
            await this.screenShareMonitor.injectMonitor(this.state.window);
            await this.uiManager.injectDebugOverlay(
                this.state.window,
                this.config,
                this.nativeCapture && this.nativeCapture.isNativeAvailable(),
                false,
                this.useVirtualCableMode,
                () => this.getDebugInfo()
            );

            if (this.nativeCapture) {
                this.nativeCapture.setDebugCallback((packetInfo) => {
                    if (this.state.window && !this.state.window.isDestroyed()) {
                        this.state.window.webContents.executeJavaScript(`
                            if (window.updateAudioPacket) {
                                window.updateAudioPacket(${JSON.stringify(packetInfo)});
                            }
                        `).catch(() => {});
                    }
                });
            }
            log.info("✅ Native handlers injected successfully");
        } catch (error: any) {
            log.error(`Failed to inject handlers: ${error.message}`);
        }
    }

    private async getDebugInfo(): Promise<any> {
        return {
            hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
            isStreamActive: this.state.isStreamActive,
            streamId: this.state.streamId,
            useVirtualCable: this.useVirtualCableMode,
            nativeCaptureActive: this.nativeCapture.isCapturing,
            videoFrameCount: this.state.videoFrameCount,
            audioFrameCount: this.state.audioFrameCount,
            lastSelectedSource: this.state.lastSelectedSourceId,
            currentQuality: this.videoQualityManager.getCurrentSettings().name,
            hasAddon: this.nativeCapture && this.nativeCapture.isNativeAvailable()
        };
    }

    async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        log.info("[JITSI-NATIVE-MANAGER] Starting native stream injection");
        if (this.state.isStreamActive) {
            log.warn("[JITSI-NATIVE-MANAGER] Stream already active, resetting...");
            await this.cleanup();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No active Jitsi window" };
        }

        const electronSourceId = this.state.lastSelectedSourceId;
        if (!electronSourceId) {
            return { success: false, error: "No source selected" };
        }

        try {
            if (this.useVirtualCableMode) {
                // 🆕 Режим Virtual Cable: видео от Electron + аудио с VB-Cable
                log.info("[VC-MODE] 🎛️ Virtual Cable mode - using Electron video + VB-Cable audio");
                const result = await this.createVirtualCableHybridStream(electronSourceId);
                if (result.success) {
                    this.state.isStreamActive = true;
                    this.state.streamId = result.streamId;
                    log.info("[VC-MODE] ✅ Hybrid stream via Virtual Cable created successfully");
                    log.info(`[VC-MODE] Stream ID: ${result.streamId}`);
                }
                return result;
            } else {
                // 🎯 Стандартный режим: полностью через Jitsi SDK (видео + аудио от системы)
                log.info("[STANDARD-MODE] 🎬 Using Jitsi SDK standard screen capture");
                const result = await this.createJitsiStandardStream(electronSourceId);
                if (result.success) {
                this.state.isStreamActive = true;
                    this.state.streamId = result.streamId;
                    log.info("[STANDARD-MODE] ✅ Standard Jitsi stream created successfully");
                }
                return result;
            }
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // 🆕 Стандартный режим: Jitsi SDK захват экрана (видео + системный звук)
    private async createJitsiStandardStream(electronSourceId: string): Promise<any> {
        log.info(`[STANDARD-MODE] Creating standard Jitsi stream`);
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No window" };
        }

        const qualitySettings = this.videoQualityManager.getCurrentSettings();

        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[STANDARD-MODE] 🎬 Starting standard screen capture...');
                    const startTime = performance.now();
                    
                    try {
                        // Очистка предыдущих потоков
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(t => t.stop());
                            window.jitsiNativeMediaStream = null;
                        }

                        // Захват экрана со звуком через стандартный Electron API
                        const stream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                mandatory: {
                                    chromeMediaSource: 'desktop'
                                }
                            },
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

                        const videoTracks = stream.getVideoTracks();
                        const audioTracks = stream.getAudioTracks();
                        
                        console.log('[STANDARD-MODE] 📊 Captured tracks: ' + videoTracks.length + ' video, ' + audioTracks.length + ' audio');
                        
                        if (videoTracks.length === 0) {
                            throw new Error('No video track captured');
                        }

                        // Получаем информацию о видео
                        const videoSettings = videoTracks[0].getSettings();
                        console.log('[STANDARD-MODE] 📐 Video: ' + videoSettings.width + 'x' + videoSettings.height + ' @ ' + videoSettings.frameRate + 'fps');

                        window.jitsiNativeMediaStream = stream;
                        window.isNativeActive = true;
                        window.isScreenShareActive = true;
                        window.isHybridMode = false;
                        window.isVirtualCableMode = false;

                        const totalTime = performance.now() - startTime;
                        console.log('[STANDARD-MODE] ✅ Stream created in ' + totalTime.toFixed(0) + 'ms');
                        
                        return { 
                            success: true, 
                            streamId: stream.id,
                            hasAudio: audioTracks.length > 0
                        };
                    } catch (error) {
                        console.error('[STANDARD-MODE] ❌ Error:', error);
                        return { success: false, error: error.message };
                    }
                })();
            `);

            if (result.success) {
                await this.notifyScreenShareStart();
                if (!result.hasAudio) {
                    log.warn("[STANDARD-MODE] ⚠️ No system audio captured - this is normal for window capture");
                }
            }
            return result;
        } catch (error: any) {
            log.error(`[STANDARD-MODE] createJitsiStandardStream ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // 🆕 НОВЫЙ МЕТОД: создание потока с использованием Virtual Cable
    private async createVirtualCableHybridStream(electronSourceId: string): Promise<any> {
        log.info(`[VC-MODE] Creating hybrid stream with Virtual Cable`);
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No window" };
        }

        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        const ringBufferCode = getRingBufferCode();

        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    window.__creatingHybridStream = true;
                    try {
                        // Очистка
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(t => t.stop());
                            window.jitsiNativeMediaStream = null;
                        }

                        // 1. Захват ВИДЕО через Electron (оптимизированный)
                        console.log('[VC-MODE] 🎬 Starting video capture with optimizations...');
                        const captureStartTime = performance.now();
                        
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

                        const captureTime = performance.now() - captureStartTime;
                        console.log('[VC-MODE] ⚡ Video capture initialized in ' + captureTime.toFixed(0) + 'ms');
                        
                        // Получаем информацию о захваченном видео
                        const videoTrack = videoStream.getVideoTracks()[0];
                        if (videoTrack) {
                            const settings = videoTrack.getSettings();
                            console.log('[VC-MODE] 📐 Video dimensions: ' + settings.width + 'x' + settings.height + ' @ ' + settings.frameRate + 'fps');
                            
                            // Применяем оптимизации к видеотреку
                            try {
                                await videoTrack.applyConstraints({
                                    // Приоритет плавности над качеством
                                    frameRate: { ideal: ${qualitySettings.frameRate.max}, max: ${qualitySettings.frameRate.max} },
                                    // Уменьшаем задержку
                                    latency: { ideal: 0, max: 0.1 }
                                });
                                console.log('[VC-MODE] ✅ Video optimizations applied');
                            } catch (e) {
                                console.log('[VC-MODE] ⚠️ Could not apply all optimizations:', e.message);
                            }
                        }

                        // 2. Захват АУДИО с виртуального кабеля (CABLE Output)
                        // ВАЖНО: CABLE Input - это куда идёт звук (playback)
                        //        CABLE Output - это откуда захватываем (recording)
                        let audioStream;
                        try {
                            const devices = await navigator.mediaDevices.enumerateDevices();
                            
                            // Логируем ВСЕ аудиоустройства для диагностики
                            const audioInputs = devices.filter(d => d.kind === 'audioinput');
                            console.log('[VC-MODE] 🔊 ALL audio INPUT (recording) devices:');
                            audioInputs.forEach((d, i) => {
                                console.log('[VC-MODE]   ' + i + ': "' + d.label + '" (id: ' + d.deviceId.substring(0, 12) + ')');
                            });
                            
                            // Паттерны для CABLE Output (устройство записи)
                            // На Windows VB-Cable показывает "CABLE Output (VB-Audio Virtual Cable)" как input device
                            const vcPatterns = [
                                'cable output',     // 🎯 Приоритет! Это то что нам нужно
                                'vb-audio virtual cable',
                                'cable input',      // Fallback (иногда так называется)
                                'voicemeeter',      
                                'vb-audio',         
                                'virtual audio',    
                                'virtual cable',    
                                'blackhole',        
                                'soundflower'       
                            ];
                            
                            // Сначала ищем точное совпадение с "cable output"
                            let vcDevice = audioInputs.find(d => 
                                d.label.toLowerCase().includes('cable output')
                            );
                            
                            // Если не нашли, ищем по остальным паттернам
                            if (!vcDevice) {
                                vcDevice = audioInputs.find(d => {
                                const label = d.label.toLowerCase();
                                return vcPatterns.some(pattern => label.includes(pattern));
                            });
                            }
                            
                            if (vcDevice) {
                                console.log('[VC-MODE] ✅ Found Virtual Cable RECORDING device: "' + vcDevice.label + '"');
                                audioStream = await navigator.mediaDevices.getUserMedia({
                                    audio: { 
                                        deviceId: { exact: vcDevice.deviceId },
                                        echoCancellation: false,
                                        noiseSuppression: false,
                                        autoGainControl: false,
                                        sampleRate: 48000,
                                        channelCount: 2
                                    },
                                    video: false
                                });
                                console.log('[VC-MODE] ✅ Audio stream acquired from: "' + vcDevice.label + '"');
                                console.log('[VC-MODE] 🎵 Audio tracks: ' + audioStream.getAudioTracks().length);
                            } else {
                                const deviceList = audioInputs.map(d => '"' + d.label + '"').join(', ') || 'none found';
                                console.error('[VC-MODE] ❌ Virtual Cable OUTPUT not found!');
                                console.error('[VC-MODE] Available recording devices: ' + deviceList);
                                console.error('[VC-MODE] 💡 Make sure VB-Cable is installed and "CABLE Output" is visible in Sound settings > Recording');
                                throw new Error(
                                    'Virtual Cable OUTPUT not found. ' +
                                    'Install VB-Cable from https://vb-audio.com/Cable/ ' +
                                    'Available: ' + deviceList
                                );
                            }
                        } catch (e) {
                            console.error('[VC-MODE] ❌ Audio capture failed:', e);
                            const errorMessage = e instanceof Error ? e.message : String(e);
                            throw new Error('Failed to capture audio from Virtual Cable: ' + errorMessage);
                        }

                        // 3. Создание финального потока с чёрным фоном
                        console.log('[VC-MODE] 🎨 Creating final stream with black background...');
                        
                        const originalVideoTrack = videoStream.getVideoTracks()[0];
                        const videoSettings = originalVideoTrack.getSettings();
                        const sourceWidth = videoSettings.width || 1920;
                        const sourceHeight = videoSettings.height || 1080;
                        
                        // Определяем нужна ли обработка через canvas (для нестандартных размеров)
                        const aspectRatio = sourceWidth / sourceHeight;
                        const isNonStandardAspect = aspectRatio < 1.0 || aspectRatio > 2.5; // Вертикальное или сверхширокое
                        
                        let finalVideoTrack = originalVideoTrack;
                        
                        if (isNonStandardAspect) {
                            console.log('[VC-MODE] 📐 Non-standard aspect ratio detected: ' + aspectRatio.toFixed(2) + ', applying black background');
                            
                            // Создаём canvas для обработки с чёрным фоном
                            const canvas = document.createElement('canvas');
                            const targetWidth = 1920;
                            const targetHeight = 1080;
                            canvas.width = targetWidth;
                            canvas.height = targetHeight;
                            
                            // Добавляем canvas в DOM (скрытый) - это помогает с инициализацией
                            canvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
                            document.body.appendChild(canvas);
                            
                            // Получаем контекст с настройками для низкой задержки
                            const ctx = canvas.getContext('2d', { 
                                alpha: false,           // Без альфа-канала
                                willReadFrequently: false,
                                desynchronized: true    
                            });
                            
                            // ⚠️ СПОСОБ 1: fillRect
                            ctx.fillStyle = '#000000';
                            ctx.fillRect(0, 0, targetWidth, targetHeight);
                            
                            // ⚠️ СПОСОБ 2: Явно заполняем ВСЕ пиксели через ImageData (гарантия чёрного)
                            const imageData = ctx.createImageData(targetWidth, targetHeight);
                            const data = imageData.data;
                            // Каждый пиксель: R=0, G=0, B=0, A=255 (чёрный непрозрачный)
                            for (let i = 0; i < data.length; i += 4) {
                                data[i] = 0;     // R
                                data[i + 1] = 0; // G
                                data[i + 2] = 0; // B
                                data[i + 3] = 255; // A (полностью непрозрачный!)
                            }
                            ctx.putImageData(imageData, 0, 0);
                            
                            console.log('[VC-MODE] 🖤 Canvas initialized with black background (ImageData)');
                            
                            // Создаём video элемент для отрисовки
                            const videoElement = document.createElement('video');
                            videoElement.srcObject = videoStream;
                            videoElement.muted = true;
                            videoElement.autoplay = true;
                            videoElement.playsInline = true;
                            
                            await new Promise(resolve => {
                                videoElement.onloadedmetadata = resolve;
                                setTimeout(resolve, 1000); // Fallback
                            });
                            await videoElement.play();
                            
                            // Рассчитываем размеры с сохранением пропорций
                            let drawWidth, drawHeight, offsetX, offsetY;
                            if (sourceWidth / sourceHeight > targetWidth / targetHeight) {
                                drawWidth = targetWidth;
                                drawHeight = targetWidth / (sourceWidth / sourceHeight);
                                offsetX = 0;
                                offsetY = (targetHeight - drawHeight) / 2;
                            } else {
                                drawHeight = targetHeight;
                                drawWidth = targetHeight * (sourceWidth / sourceHeight);
                                offsetX = (targetWidth - drawWidth) / 2;
                                offsetY = 0;
                            }
                            
                            console.log('[VC-MODE] 📏 Draw params: ' + drawWidth.toFixed(0) + 'x' + drawHeight.toFixed(0) + ' at (' + offsetX.toFixed(0) + ',' + offsetY.toFixed(0) + ')');
                            
                            // Отрисовываем первый кадр синхронно!
                            ctx.fillStyle = '#000000';
                            ctx.fillRect(0, 0, targetWidth, targetHeight);
                            ctx.drawImage(videoElement, offsetX, offsetY, drawWidth, drawHeight);
                            
                            // Функция отрисовки кадра
                            let frameCount = 0;
                            function drawFrame() {
                                if (!window.isScreenShareActive) {
                                    console.log('[VC-MODE] 🛑 Screen share stopped, ending draw loop');
                                    return;
                                }
                                
                                // Сбрасываем трансформации и композитный режим
                                ctx.setTransform(1, 0, 0, 1, 0, 0);
                                ctx.globalCompositeOperation = 'source-over';
                                
                                // Чёрный фон - ПОЛНОСТЬЮ заполняем (метод 1)
                                ctx.fillStyle = '#000000';
                                ctx.fillRect(0, 0, targetWidth, targetHeight);
                                
                                // Дополнительно: clearRect + fillRect для гарантии (метод 2)
                                // ctx.clearRect(0, 0, targetWidth, targetHeight);
                                // ctx.fillRect(0, 0, targetWidth, targetHeight);
                                
                                // Видео по центру с сохранением пропорций
                                if (videoElement.readyState >= 2) { // HAVE_CURRENT_DATA
                                    ctx.drawImage(videoElement, offsetX, offsetY, drawWidth, drawHeight);
                                }
                                
                                frameCount++;
                                if (frameCount % 300 === 0) { // Логируем каждые ~10 сек при 30fps
                                    console.log('[VC-MODE] 🎬 Frame count: ' + frameCount);
                                }
                                
                                requestAnimationFrame(drawFrame);
                            }
                            
                            // Создаём поток из canvas ПОСЛЕ первого кадра
                            const canvasStream = canvas.captureStream(${qualitySettings.frameRate.max});
                            finalVideoTrack = canvasStream.getVideoTracks()[0];
                            
                            // Запускаем цикл отрисовки
                            drawFrame();
                            
                            // Сохраняем ссылки для очистки
                            window.__vcCanvasCleanup = () => {
                                window.isScreenShareActive = false;
                                videoElement.pause();
                                videoElement.srcObject = null;
                                originalVideoTrack.stop();
                                // Удаляем canvas из DOM
                                if (canvas.parentNode) {
                                    canvas.parentNode.removeChild(canvas);
                                }
                                console.log('[VC-MODE] 🧹 Canvas cleanup completed');
                            };
                            
                            console.log('[VC-MODE] ✅ Canvas processing enabled for black background');
                        } else {
                            console.log('[VC-MODE] ✅ Standard aspect ratio, using direct stream');
                        }
                        
                        // 4. Объединение финального потока
                        const hybridStream = new MediaStream();
                        hybridStream.addTrack(finalVideoTrack);
                        hybridStream.addTrack(audioStream.getAudioTracks()[0]);

                        window.jitsiNativeMediaStream = hybridStream;
                        window.isNativeActive = true;
                        window.isScreenShareActive = true;
                        window.isHybridMode = true;
                        window.isVirtualCableMode = true;

                        const totalTime = performance.now() - captureStartTime;
                        console.log('[VC-MODE] ✅ Hybrid stream created in ' + totalTime.toFixed(0) + 'ms');
                        console.log('[VC-MODE] 📊 Final stream: ' + hybridStream.getVideoTracks().length + ' video, ' + hybridStream.getAudioTracks().length + ' audio');
                        return { success: true, streamId: hybridStream.id };
                    } catch (error) {
                        console.error('[VC-MODE] Error:', error);
                        return { success: false, error: error.message };
                    } finally {
                        window.__creatingHybridStream = false;
                    }
                })();
            `);

            if (result.success) {
                await this.notifyScreenShareStart();
            }
            return result;
        } catch (error: any) {
            log.error(`[VC-MODE] createVirtualCableHybridStream ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // ===== МЕТОДЫ ДЛЯ НАТИВНОГО ЗАХВАТА (не Virtual Cable) =====
    
    private async startNativeAudioCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        log.info("[JITSI-VC] Starting native audio capture");
        log.info(`[JITSI-VC] Electron sourceId: ${sourceId}`);
        
        try {
            const nativeSourceId = await this.convertElectronToNativeId(sourceId);
            log.info(`[JITSI-VC] Converted to native ID: ${nativeSourceId}`);
            
            const result = await this.nativeCapture.startAudioOnlyCapture(nativeSourceId);
            
            if (result.success) {
                log.info("[JITSI-VC] Audio-only capture started");
            } else {
                log.error(`[JITSI-VC] Audio-only capture failed: ${result.error}`);
            }
            
            return result;
            
        } catch (error: any) {
            log.error(`[JITSI-VC] startNativeAudioCapture ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async convertElectronToNativeId(electronSourceId: string): Promise<string> {
        log.info(`[JITSI-VC] Converting Electron ID: ${electronSourceId}`);
        
        if (electronSourceId.startsWith('screen:')) {
            const parts = electronSourceId.split(':');
            const displayId = parts[1] || '0';
            
            if (this.isWindowsPlatform()) {
                return `screen:${displayId}:0`;
            } else {
                return `display:${displayId}`;
            }
        } else if (electronSourceId.startsWith('window:')) {
            const parts = electronSourceId.split(':');
            const windowId = parts[1] || '0';
            
            if (this.isWindowsPlatform()) {
                const nativeSources = await this.nativeCapture.getSources();
                const electronSources = await this.getElectronSources();
                const electronWindow = electronSources.find(s => s.id === electronSourceId);
                
                if (electronWindow) {
                    const nativeWindow = nativeSources.find(ns => 
                        ns.name && electronWindow.name && 
                        ns.name.includes(electronWindow.name)
                    );
                    
                    if (nativeWindow) {
                        return `window:${nativeWindow.id}:0`;
                    }
                }
                
                return `window:${windowId}:0`;
            } else {
                return `window:${windowId}`;
            }
        }
        
        log.warn(`[JITSI-VC] Unknown format, returning as-is: ${electronSourceId}`);
        return electronSourceId;
    }

    private isWindowsPlatform(): boolean {
        return process.platform === 'win32';
    }

    private async getElectronSources(): Promise<any[]> {
        const { desktopCapturer } = require('electron');
        return await desktopCapturer.getSources({
            types: ['window', 'screen']
        });
    }

    private async createHybridStreamInJitsi(electronSourceId: string): Promise<any> {
        log.info(`[JITSI-VC] createHybridStreamInJitsi: ${electronSourceId}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[JITSI-VC] No window");
            return { success: false, error: "No window" };
        }
        
        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        const ringBufferCode = getRingBufferCode();
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    const isWindows = ${this.isWindowsPlatform()};
                    window.__creatingHybridStream = true;
                    console.log('[JITSI-VC] Creating hybrid stream, platform:', isWindows ? 'Windows' : 'macOS');
                    
                    try {
                        // Очистка
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                track.stop();
                            });
                            window.jitsiNativeMediaStream = null;
                        }

                        if (window.screenShareAudioContext) {
                            try {
                                await window.screenShareAudioContext.close();
                            } catch (e) {}
                            window.screenShareAudioContext = null;
                        }

                        window.isNativeActive = false;
                        window.isScreenShareActive = false;

                        ${ringBufferCode}
                        
                        // 1. Получаем VIDEO от Electron
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

                        window.__creatingHybridStream = false;
                        window.jitsiNativeMediaStream = videoStream;
                        window.isNativeActive = true;
                        
                        const videoTrack = videoStream.getVideoTracks()[0];
                        if (!videoTrack) {
                            throw new Error('No video track');
                        }
                        
                        // 2. Создаем аудио контекст
                        const screenShareAudioContext = new AudioContext({ 
                            sampleRate: 48000, 
                            latencyHint: 'interactive' 
                        });
                        
                        window.screenShareAudioContext = screenShareAudioContext;
                        
                        const scriptProcessor = screenShareAudioContext.createScriptProcessor(2048, 0, 2);
                        
                        // 3. Создаем буферы
                        window.screenShareLeftBuffer = new RingBuffer(48000);
                        window.screenShareRightBuffer = new RingBuffer(48000);
                        window.leftRingBuffer = window.screenShareLeftBuffer;
                        window.rightRingBuffer = window.screenShareRightBuffer;
                        
                        // 4. Обработка аудио
                        scriptProcessor.onaudioprocess = (event) => {                            
                            const leftChannel = event.outputBuffer.getChannelData(0);
                            const rightChannel = event.outputBuffer.getChannelData(1);
                            
                            if (window.screenShareLeftBuffer && window.screenShareRightBuffer) {
                                window.screenShareLeftBuffer.read(leftChannel);
                                window.screenShareRightBuffer.read(rightChannel);
                            }
                        };
                        
                        const destination = screenShareAudioContext.createMediaStreamDestination();
                        scriptProcessor.connect(destination);
                        
                        // 5. Создаем поток
                        const screenShareStream = new MediaStream();
                        screenShareStream.addTrack(videoTrack);
                        
                        if (destination.stream.getAudioTracks().length > 0) {
                            const audioTrack = destination.stream.getAudioTracks()[0];
                            audioTrack.contentHint = 'screenshare';
                            screenShareStream.addTrack(audioTrack);
                        }
                        
                        window.jitsiNativeMediaStream = screenShareStream;
                        window.screenShareStream = screenShareStream;
                        window.nativeAudioContext = screenShareAudioContext;
                        window.isNativeActive = true;
                        window.isScreenShareActive = true;
                        window.isHybridMode = true;
                        
                        if (screenShareAudioContext.state === 'suspended') {
                            await screenShareAudioContext.resume();
                        }
                        
                        videoTrack.addEventListener('ended', async () => {
                            console.log('[JITSI-VC] Video track ended, cleaning up...');
                            if (window.screenShareAudioContext) {
                                try {
                                    await window.screenShareAudioContext.close();
                                } catch (e) {}
                                window.screenShareAudioContext = null;
                            }
                            window.isScreenShareActive = false;
                            window.isNativeActive = false;
                        });
                        
                        return {
                            success: true,
                            streamId: screenShareStream.id,
                            hasVideo: screenShareStream.getVideoTracks().length > 0,
                            hasAudio: screenShareStream.getAudioTracks().length > 0
                        };
                        
                    } catch (error) {
                        console.error('[JITSI-VC] Error:', error);
                        return { success: false, error: error.message };
                    }
                })();
            `);
            
            if (result && result.success) {
                await this.notifyScreenShareStart();
            }

            log.info(`[JITSI-VC] Hybrid stream result:`, result);
            return result;
            
        } catch (error: any) {
            log.error(`[JITSI-VC] createHybridStreamInJitsi ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private setupAudioCallbacks(): void {
        log.info("[JITSI-VC] setupAudioCallbacks");
        
        this.state.videoFrameCount = 0;
        this.state.audioFrameCount = 0;
        
        this.nativeCapture.setFrameCallbacks(
            // Video callback - игнорируем (используем Electron)
            (videoData: any) => {
                this.state.videoFrameCount = (this.state.videoFrameCount || 0) + 1;
            },
            
            // Audio callback - обрабатываем
            (audioData: any) => {
                this.processNativeAudio(audioData);
            }
        );
        
        log.info("[JITSI-VC] setupAudioCallbacks DONE");
    }

    private processNativeAudio(audioData: any): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        this.state.audioFrameCount = (this.state.audioFrameCount || 0) + 1;
        
        try {
            const arrayBuffer = audioData.data;
            const samples = this.audioProcessor.getSamplesForPlatform(audioData);
            const channels = audioData.channels || 2;
            
            const { leftChannel, rightChannel } = this.audioProcessor.decodeAudio(
                arrayBuffer, 
                samples, 
                channels
            );
            
            const levels = this.audioProcessor.analyzeAudioLevels(leftChannel, rightChannel);
            
            const { processedLeft, processedRight } = this.audioProcessor.normalizeAudio(
                leftChannel, 
                rightChannel, 
                levels
            );
            
            this.sendAudioToJitsi(processedLeft, processedRight, samples);
        } catch (error: any) {
            log.error(`[JITSI-VC] processNativeAudio ERROR: ${error.message}`);
        }
    }

    private sendAudioToJitsi(leftData: Float32Array, rightData: Float32Array, samples: number): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        const jsCode = getSendAudioToJitsiCode(leftData, rightData, samples);
        
        this.state.window.webContents.executeJavaScript(jsCode).catch((err) => {
            log.error(`[JITSI-VC] sendAudioToJitsi error: ${err.message}`);
        });
    }

    private async notifyScreenShareStart(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    if (window.APP?.conference?._room) {
                        const room = window.APP.conference._room;
                        const myId = room.myUserId ? room.myUserId() : 'unknown';
                        window.isPresenter = true;
                        if (room.sendCommand) {
                            room.sendCommand('SCREEN_SHARE_STARTED', {
                                value: JSON.stringify({
                                    presenterId: myId,
                                    timestamp: Date.now(),
                                    audioMode: ${this.useVirtualCableMode ? "'virtual_cable'" : "'system_only'"}
                                })
                            });
                        }
                    }
                })();
            `);
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] notifyScreenShareStart error: ${error.message}`);
        }
    }

    // ... остальные приватные методы (processNativeAudio, sendAudioToJitsi, cleanup, closeWindow и т.д.)

    private startDebugMonitoring(): void {
        if (!this.config.enableDebugUI || this.debugMonitoringInterval) return;
        this.debugMonitoringInterval = setInterval(async () => {
            if (!this.state.window || this.state.window.isDestroyed()) {
                if (this.debugMonitoringInterval) {
                    clearInterval(this.debugMonitoringInterval as unknown as number);
                }
                this.debugMonitoringInterval = undefined;
                return;
            }
            try {
                const debugInfo = await this.getDebugInfo();
                await this.state.window.webContents.executeJavaScript(`
                    if (window.updateDebugIndicator) {
                        window.updateDebugIndicator(${JSON.stringify(debugInfo)});
                    }
                `);
            } catch {}
        }, 2000);
    }

    async changeVideoQuality(presetName: keyof typeof VIDEO_QUALITY_PRESETS): Promise<{ success: boolean; quality?: string; error?: string }> {
        log.info(`[JITSI-NATIVE-MANAGER] Changing video quality to: ${presetName}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No window available" };
        }
        
        try {
            const preset = this.videoQualityManager.setPreset(presetName);
            
            // Используем функцию из video-quality-manager
            const result = await this.state.window.webContents.executeJavaScript(
                getApplyQualityPresetCode(preset, String(presetName))
            );
            
            if (result.success) {
                log.info(`[JITSI-NATIVE-MANAGER] Video quality changed successfully to: ${result.quality}`);
                this.config.videoQuality = presetName;
            }
            
            return result;
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Failed to change quality: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async setCustomVideoQuality(width: number, height: number, fps: number): Promise<{ success: boolean; quality?: string; error?: string }> {
        log.info(`[JITSI-NATIVE-MANAGER] Setting custom video quality: ${width}x${height}@${fps}fps`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No window available" };
        }
        
        try {
            this.videoQualityManager.setCustomQuality({
                width: { min: Math.floor(width * 0.8), max: width },
                height: { min: Math.floor(height * 0.8), max: height },
                frameRate: { min: Math.max(1, fps - 5), max: fps }
            });
            
            const result = await this.state.window.webContents.executeJavaScript(`
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
            `);
            
            if (result.success) {
                log.info(`[JITSI-NATIVE-MANAGER] Custom quality applied: ${result.quality}`);
            }
            
            return result;
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Failed to set custom quality: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async cleanup(): Promise<void> {
        log.info("[JITSI-NATIVE-MANAGER] Starting cleanup...");
        
        try {
            // 🆕 Восстанавливаем звук приложения, если был перенаправлен
            if (this.routedProcessName) {
                await this.restoreAppAudio(this.routedProcessName);
            }
            
            if(this.state.window){
                await JitsiWindowUtils.nukeClearAllStreams(this.state.window);

                await new Promise(resolve => setTimeout(resolve, 200));
                
                if (this.nativeCapture && this.nativeCapture.isCapturing) {
                    await this.nativeCapture.stopCapture();
                }
                
                await JitsiWindowUtils.forceReleaseAllMediaResources(this.state.window);
                
                this.nativeCapture.setFrameCallbacks(undefined, undefined);
                
                this.state.isStreamActive = false;
                this.state.streamId = null;
                this.state.videoFrameCount = 0;
                this.state.audioFrameCount = 0;
                this.activeMediaStreams.clear();
                this.routedProcessName = null;

                if (this.debugMonitoringInterval) {
                    clearInterval(this.debugMonitoringInterval as NodeJS.Timeout);
                    this.debugMonitoringInterval = undefined;
                }
            }
            
            log.info("[JITSI-NATIVE-MANAGER] Cleanup completed");
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Cleanup error: ${error.message}`);
        }
    }
    
    // 🆕 Автоматический поиск и маршрутизация аудио по имени источника
    private async tryAutoRouteAudio(sourceName: string): Promise<void> {
        try {
            log.info(`[VC-MODE] 🔍 Trying to auto-route audio for: "${sourceName}"`);
            
            // Проверяем готовность SVV
            const isReady = await this.audioSessionService.isReady();
            if (!isReady) {
                log.warn("[VC-MODE] ⚠️ SoundVolumeView not ready - cannot route audio");
                log.warn("[VC-MODE] Audio will be captured from ALL apps going to VB-Cable");
                return;
            }
            
            // Получаем список аудио сессий
            const sessions = await this.audioSessionService.getAudioSessions();
            log.info(`[VC-MODE] Found ${sessions.length} audio sessions:`);
            sessions.forEach(s => {
                log.info(`[VC-MODE]   - ${s.processName} (${s.displayName}) - ${s.volume}%`);
            });
            
            if (sessions.length === 0) {
                log.warn("[VC-MODE] ⚠️ No audio sessions found - start an app with sound first!");
                return;
            }
            
            // Пытаемся найти совпадение по имени
            const sourceNameLower = sourceName.toLowerCase();
            
            // 🆕 Маппинг известных Windows UWP приложений (название окна → процесс)
            const uwpAppMapping: Record<string, string[]> = {
                'медиаплеер': ['microsoft.media.player'],
                'media player': ['microsoft.media.player'],
                'фотографии': ['microsoft.photos'],
                'photos': ['microsoft.photos'],
                'кино и тв': ['microsoft.zunevideo', 'video.ui'],
                'movies & tv': ['microsoft.zunevideo', 'video.ui'],
                'музыка groove': ['microsoft.zunemusic'],
                'groove music': ['microsoft.zunemusic'],
                'калькулятор': ['calculator'],
                'calculator': ['calculator'],
                'spotify': ['spotify'],
                'vlc': ['vlc'],
                'itunes': ['itunes'],
            };
            
            // Проверяем UWP маппинг
            for (const [windowName, processPatterns] of Object.entries(uwpAppMapping)) {
                if (sourceNameLower.includes(windowName)) {
                    const uwpMatch = sessions.find(s => {
                        const processLower = s.processName.toLowerCase().replace('.exe', '');
                        return processPatterns.some(p => processLower.includes(p));
                    });
                    if (uwpMatch) {
                        log.info(`[VC-MODE] 🎯 UWP mapping: "${sourceName}" → "${uwpMatch.processName}"`);
                        const result = await this.routeAppAudioToCable(uwpMatch.processName);
                        if (result.success) {
                            log.info(`[VC-MODE] ✅ Auto-routed ${uwpMatch.processName} to VB-Cable`);
                        }
                        return;
                    }
                }
            }
            
            // Известные браузеры - если заголовок окна содержит название сайта, 
            // а в sessions есть браузер - это скорее всего он
            const browserProcesses = ['chrome', 'firefox', 'msedge', 'opera', 'brave', 'yandex', 'vivaldi', 'browser'];
            const gameProcesses = ['cs2', 'dota2', 'valorant', 'steam', 'epicgames', 'discord'];
            
            let matchedSession = sessions.find(s => {
                const processLower = s.processName.toLowerCase().replace('.exe', '');
                const displayLower = s.displayName.toLowerCase();
                
                // Прямое совпадение
                if (sourceNameLower.includes(processLower) || 
                    sourceNameLower.includes(displayLower) ||
                    processLower.includes(sourceNameLower.split(' ')[0]) ||
                    displayLower.includes(sourceNameLower.split(' ')[0])) {
                    return true;
                }
                
                // Проверяем паттерн браузера: "Название сайта - Chrome" или "Название сайта — Mozilla Firefox"
                const browserSuffixes = [' - google chrome', ' - chrome', ' - mozilla firefox', ' - firefox', 
                                        ' - microsoft edge', ' - edge', ' — opera', ' - brave', ' - yandex'];
                for (const suffix of browserSuffixes) {
                    if (sourceNameLower.includes(suffix.replace(' - ', '').replace(' — ', ''))) {
                        // Источник это браузер, ищем соответствующий процесс
                        const browserName = suffix.replace(' - ', '').replace(' — ', '').split(' ')[0];
                        if (processLower.includes(browserName)) {
                            return true;
                        }
                    }
                }
                
                return false;
            });
            
            // Если не нашли прямое совпадение, но есть только одна сессия (кроме electron) - используем её
            if (!matchedSession) {
                const nonElectronSessions = sessions.filter(s => 
                    !s.processName.toLowerCase().includes('electron')
                );
                if (nonElectronSessions.length === 1) {
                    matchedSession = nonElectronSessions[0];
                    log.info(`[VC-MODE] 💡 Only one non-Electron audio session found, using it: ${matchedSession.processName}`);
                }
            }
            
            // Если всё ещё не нашли, проверяем известные браузеры/игры
            if (!matchedSession) {
                matchedSession = sessions.find(s => {
                    const processLower = s.processName.toLowerCase().replace('.exe', '');
                    return browserProcesses.some(b => processLower.includes(b)) ||
                           gameProcesses.some(g => processLower.includes(g));
                });
                if (matchedSession) {
                    log.info(`[VC-MODE] 💡 Found known app in sessions: ${matchedSession.processName}`);
                }
            }
            
            if (matchedSession) {
                log.info(`[VC-MODE] ✅ Matched source "${sourceName}" to process "${matchedSession.processName}"`);
                const result = await this.routeAppAudioToCable(matchedSession.processName);
                if (result.success) {
                    log.info(`[VC-MODE] ✅ Auto-routed ${matchedSession.processName} to VB-Cable`);
                } else {
                    log.warn(`[VC-MODE] ⚠️ Failed to auto-route: ${result.error}`);
                }
            } else {
                log.warn(`[VC-MODE] ⚠️ No matching audio session found for "${sourceName}"`);
                log.info("[VC-MODE] 💡 TIP: Make sure the app you want to share is playing audio!");
                log.info("[VC-MODE] Available sessions for manual selection:");
                sessions.forEach(s => {
                    log.info(`[VC-MODE]   → ${s.processName} (${s.displayName})`);
                });
            }
        } catch (error: any) {
            log.error(`[VC-MODE] ❌ Auto-route error: ${error.message}`);
        }
    }
    
    // 🆕 Метод для перенаправления звука приложения на VB-Cable
    private async routeAppAudioToCable(processName: string): Promise<{ success: boolean; error?: string }> {
        try {
            if (!this.useVirtualCableMode) {
                return { success: false, error: "Virtual Cable mode is not enabled" };
            }
            
            const vcDeviceName = await this.audioSessionService.getVBCableDeviceName();
            if (!vcDeviceName) {
                return { success: false, error: "VB-Cable device not found" };
            }
            
            const success = await this.audioSessionService.setAppAudioDevice(processName, vcDeviceName);
            if (success) {
                this.routedProcessName = processName;
                log.info(`[VC-MODE] ✅ Routed ${processName} audio to ${vcDeviceName}`);
            }
            
            return { success };
        } catch (error: any) {
            log.error(`[VC-MODE] Error routing ${processName} audio:`, error);
            return { success: false, error: error.message };
        }
    }
    
    // 🆕 Метод для восстановления звука приложения на устройство по умолчанию
    private async restoreAppAudio(processName: string): Promise<{ success: boolean; error?: string }> {
        try {
            const success = await this.audioSessionService.restoreDefaultDevice(processName);
            if (success) {
                if (this.routedProcessName === processName) {
                    this.routedProcessName = null;
                }
                log.info(`[VC-MODE] ✅ Restored ${processName} audio to default device`);
            }
            
            return { success };
        } catch (error: any) {
            log.error(`[VC-MODE] Error restoring ${processName} audio:`, error);
            return { success: false, error: error.message };
        }
    }

    // 🆕 Публичный метод для восстановления всех перенаправленных аудио
    public async restoreRoutedAudio(): Promise<{ success: boolean; error?: string }> {
        if (!this.routedProcessName) {
            log.info("[VC-MODE] No routed process to restore");
            return { success: true };
        }
        
        if (!this.useVirtualCableMode) {
            log.info("[VC-MODE] Virtual Cable mode is disabled, clearing routed process");
            this.routedProcessName = null;
            return { success: true };
        }
        
        log.info(`[VC-MODE] 🔄 Restoring audio for: ${this.routedProcessName}`);
        
        try {
            const success = await this.audioSessionService.restoreDefaultDevice(this.routedProcessName);
            if (success) {
                log.info(`[VC-MODE] ✅ Audio restored to default device`);
            } else {
                log.warn(`[VC-MODE] ⚠️ Failed to restore audio for ${this.routedProcessName}`);
            }
            return { success };
        } catch (error: any) {
            log.error(`[VC-MODE] ❌ Failed to restore audio: ${error.message}`);
            return { success: false, error: error.message };
        } finally {
            this.routedProcessName = null;
        }
    }

    async closeWindow(): Promise<void> {
        log.info("[JITSI-NATIVE-MANAGER] Closing window");
        
        if (!this.state.window) {
            log.info("[JITSI-NATIVE-MANAGER] No window to close");
            return;
        }
        
        try {
            await this.cleanup();
            
            if (this.state.window && !this.state.window.isDestroyed()) {
                this.state.window.removeAllListeners();
                this.state.window.close();
                log.info("[JITSI-NATIVE-MANAGER] Window closed");
            }
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Error closing window: ${error.message}`);
            
        } finally {
            this.state.window = null;
            log.info("[JITSI-NATIVE-MANAGER] Window cleanup completed");
        }
    }
}