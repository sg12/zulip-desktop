// jitsi-native-manager.ts - Упрощенный модуль для управления Jitsi окнами (только нативный режим)
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
  topic?: string;
  stream?: string;
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

export interface JitsiManagerConfig {
    videoQuality?: keyof typeof VIDEO_QUALITY_PRESETS;
    enableDebugUI?: boolean;
    enablePerformanceMonitoring?: boolean;
    monitoringInterval?: number;
}

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
        streamId: null
    };

    private nativeCapture: NativeCaptureManager;
    private bundlePath: string;
    private iconPath: string;
    private config: JitsiManagerConfig;
    private videoQualityManager: VideoQualityManager;
    private screenShareMonitor: JitsiScreenShareMonitor;
    private activeMediaStreams: Set<string> = new Set(); 
    private debugMonitoringInterval?: NodeJS.Timer;

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
        
        log.info("[JITSI-NATIVE-MANAGER] Initialized with config:", this.config);
        
        this.registerHandlers();
        this.screenShareMonitor = new JitsiScreenShareMonitor();
        
        log.info("[JITSI-NATIVE-MANAGER] Debug UI enabled:", this.config.enableDebugUI);
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
                streamId: this.state.streamId
            };
        });

        ipcMain.handle("jitsi:save-selected-source", async (event, sourceId: string) => {
            this.state.lastSelectedSourceId = sourceId;
            log.info(`Saved selected source: ${sourceId}`);
            return { success: true };
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
            
            log.info("[JITSI-NATIVE-MANAGER] Debug info:", debugInfo);
            return debugInfo;
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
                await this.nukeClearAllStreams();
                
                if (this.nativeCapture && this.nativeCapture.isCapturing) {
                    const stopResult = await this.nativeCapture.stopCapture();
                    log.info(`[JITSI-NATIVE-MANAGER] Native capture stopped: ${JSON.stringify(stopResult)}`);
                }
                
                await this.forceReleaseAllMediaResources();
                
                this.state.isStreamActive = false;
                this.state.streamId = null;
                this.state.videoFrameCount = 0;
                this.state.audioFrameCount = 0;
                
                this.nativeCapture.setFrameCallbacks(undefined, undefined);
                this.activeMediaStreams.clear();
                
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
            
            return sources.map(s => ({
                id: s.id,
                name: s.name,
                display_id: s.display_id,
                thumbnail: s.thumbnail.resize({ width: 200 }).toDataURL('image/jpeg', 0.7)
            }));
        });

        ipcMain.handle("jitsi:screen-share-stopped", async () => {
            log.info("[JITSI-NATIVE-MANAGER] Screen share stopped event received");
            
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

            await this.injectLoadingScreen();
            this.state.window.show();

            this.state.window.webContents.on('did-start-loading', () => {
                this.state.window.webContents.insertCSS(`
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
                `);
            });

            const conferenceUrl = this.buildConferenceUrl(server, roomName, options);
            
            log.info(`Loading conference URL: ${conferenceUrl}`);

            this.state.window.webContents.on('did-finish-load', async () => {
                log.info("[JITSI-NATIVE-MANAGER] Page loaded, injecting handlers...");
                
                await this.waitForJitsiReady();
                await this.hideLoadingScreen();
                
                setTimeout(async () => {
                    await this.injectDebugOverlay();
                    await this.startDebugMonitoring();
                }, 500);
            });

            await this.state.window.loadURL(conferenceUrl);

            setTimeout(() => {
                log.info("First injection attempt (3s)...");
                this.injectHandlers();
            }, 3000);
            
            setTimeout(() => {
                log.info("Second injection attempt (5s)...");
                this.injectHandlers();
            }, 5000);
            
            setTimeout(() => {
                log.info("Third injection attempt (8s)...");
                this.injectHandlers();
            }, 8000);

            this.state.window.on('close', async (event) => {
                log.info("[JITSI-NATIVE-MANAGER] Window close event triggered");
                
                event.preventDefault();

                const left = await this.leaveConference();
                if (left) {
                    log.info("[JITSI-NATIVE-MANAGER] Successfully left conference");
                    await new Promise(resolve => setTimeout(resolve, 500));
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

            log.info("Jitsi is ready, injecting native handlers...");

            const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
                !!(window.jitsiHandlersInjected)
            `);

            if (alreadyInjected) {
                log.info("Handlers already injected, skipping");
                return;
            }

            // Инъекция основных обработчиков для нативного режима
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
                                if (savedMic) {
                                    console.log('[JitsiNative] Preserving microphone before desktop creation');
                                }
                            } catch (e) {}

                            if (options && options.devices && options.devices.includes('desktop')) {
                                console.log('[JitsiNative] Desktop track requested');
                                
                                if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                    console.log('[JitsiNative] 🎯 Native stream available, injecting it...');
                                    
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
                                            console.log('[JitsiNative] 🎯 RETURNING NATIVE STREAM!');
                                            return window.jitsiNativeMediaStream;
                                        };
                                        
                                        const tracks = await originalFunctions.createLocalTracks.call(this, options);
                                        
                                        navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                        navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                        
                                        if (tracks && tracks.length > 0) {
                                            console.log('[JitsiNative] ✅ JitsiLocalTrack created successfully');
                                            
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
                                        navigator.mediaDevices.getUserMedia = tempGetUserMedia;
                                        navigator.mediaDevices.getDisplayMedia = tempGetDisplayMedia;
                                        throw e;
                                    }
                                }
                            }
                            
                            return originalFunctions.createLocalTracks.call(this, options);
                        };
                        
                        console.log('[JitsiNative] ✅ createLocalTracks intercepted');
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
                        
                        console.log('[JitsiNative] ✅ JitsiMeetScreenObtainer intercepted');
                    }
                    
                    // Глобальные перехваты
                    if (!window.originalGetDisplayMedia) {
                        originalFunctions.getDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                        
                        navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                            console.log('[JitsiNative] Global getDisplayMedia intercepted');
                            
                            if (window.jitsiNativeMediaStream && window.isNativeActive) {
                                console.log('[JitsiNative] 🎯 Returning native stream');
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
                                    console.log('[JitsiNative] 🎯 Returning native stream');
                                    return window.jitsiNativeMediaStream;
                                }
                            }
                            
                            return originalFunctions.getUserMedia.call(this, constraints);
                        };
                    }
                    
                    console.log('[JitsiNative] ✅ Complete injection finished!');
                    return true;
                })();
            `);

            // Инжектируем перехватчик выбора источников (упрощенный)
            await this.state.window.webContents.executeJavaScript(
                this.getSimplifiedScreenShareInterceptorCode()
            );

            // Обработчик выхода из конференции
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[JitsiManager] Setting up conference leave handler...');
                    
                    let leaveHandled = false;
                    
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
                    
                    const checkInterval = setInterval(() => {
                        if (window.APP && window.APP.conference && window.APP.conference._room) {
                            clearInterval(checkInterval);
                            
                            const room = window.APP.conference._room;
                            console.log('[JitsiManager] Conference room found, adding listeners...');
                            
                            if (window.JitsiMeetJS && window.JitsiMeetJS.events && window.JitsiMeetJS.events.conference) {
                                room.on(
                                    window.JitsiMeetJS.events.conference.CONFERENCE_LEFT,
                                    () => {
                                        console.log('[JitsiManager] CONFERENCE_LEFT event fired!');
                                        notifyConferenceLeft();
                                    }
                                );
                            }
                            
                            const originalLeave = room.leave;
                            room.leave = function(...args) {
                                console.log('[JitsiManager] room.leave() called');
                                notifyConferenceLeft();
                                return originalLeave.apply(this, args);
                            };
                            
                            console.log('[JitsiManager] Conference leave handlers installed');
                        }
                    }, 500);
                    
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        console.log('[JitsiManager] Stopped checking for conference room');
                    }, 20000);
                    
                    return true;
                })();
            `);

            await this.screenShareMonitor.injectMonitor(this.state.window);
            await this.injectDebugOverlay();

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

    // Упрощенный код перехватчика (без выбора режима звука)
    private getSimplifiedScreenShareInterceptorCode(): string {
        return `
            (function() {
                console.log('[JitsiManager] Installing simplified screen share interceptor...');
                
                window.__interceptorFlag = window.__interceptorFlag || false;
                let pendingSourcesCallback = null;
                
                // Предзагрузка источников
                let cachedSources = null;
                let cacheTime = 0;
                const CACHE_DURATION = 5000;
                
                async function getElectronSourcesWithCache() {
                    const now = Date.now();
                    if (cachedSources && (now - cacheTime) < CACHE_DURATION) {
                        console.log('[JitsiManager] Using cached sources');
                        return cachedSources;
                    }
                    
                    if (window.ipcRenderer) {
                        cachedSources = await window.ipcRenderer.invoke('get-electron-desktop-sources');
                        cacheTime = now;
                        return cachedSources;
                    }
                    return [];
                }
                
                // Предзагружаем источники
                setTimeout(() => {
                    getElectronSourcesWithCache().then(sources => {
                        console.log('[JitsiManager] Preloaded', sources.length, 'sources');
                    });
                }, 1000);
                
                // Функция показа выбора источника
                function showSourcePicker(sources, callback) {
                    requestAnimationFrame(() => {
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
                            background: rgba(0, 0, 0, 0);
                            z-index: 10000;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            backdrop-filter: blur(0px);
                            transition: background 0.2s, backdrop-filter 0.2s;
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
                            transform: scale(0.9);
                            opacity: 0;
                            transition: transform 0.2s, opacity 0.2s;
                        \`;
                        
                        const fragment = document.createDocumentFragment();
                        
                        const header = document.createElement('h2');
                        header.style.cssText = 'margin-top: 0; color: #333; font-size: 24px;';
                        header.textContent = 'Выберите экран или окно для демонстрации';
                        fragment.appendChild(header);
                        
                        const grid = document.createElement('div');
                        grid.style.cssText = \`
                            display: grid;
                            grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                            gap: 20px;
                            margin: 24px 0;
                        \`;
                        
                        sources.forEach(source => {
                            const item = document.createElement('div');
                            item.className = 'source-item';
                            item.dataset.sourceId = source.id;
                            item.style.cssText = \`
                                border: 3px solid #e0e0e0;
                                border-radius: 12px;
                                padding: 16px;
                                cursor: pointer;
                                text-align: center;
                                background: white;
                                transition: border-color 0.15s, transform 0.15s;
                            \`;
                            
                            const img = document.createElement('img');
                            img.src = source.thumbnail || '';
                            img.style.cssText = \`
                                width: 100%;
                                height: 160px;
                                object-fit: contain;
                                margin-bottom: 12px;
                                border-radius: 8px;
                                background: #f5f5f5;
                            \`;
                            
                            const name = document.createElement('div');
                            name.style.cssText = \`
                                font-size: 14px;
                                color: #666;
                                word-wrap: break-word;
                                font-weight: 500;
                            \`;
                            name.textContent = source.name || 'Unknown';
                            
                            item.appendChild(img);
                            item.appendChild(name);
                            
                            item.onmouseenter = () => {
                                item.style.borderColor = '#2196F3';
                                item.style.transform = 'scale(1.05)';
                            };
                            item.onmouseleave = () => {
                                item.style.borderColor = '#e0e0e0';
                                item.style.transform = 'scale(1)';
                            };
                            
                            item.onclick = () => {
                                overlay.style.background = 'rgba(0, 0, 0, 0)';
                                dialog.style.transform = 'scale(0.9)';
                                dialog.style.opacity = '0';
                                setTimeout(() => {
                                    overlay.remove();
                                    callback(source.id);
                                }, 200);
                            };
                            
                            grid.appendChild(item);
                        });
                        
                        fragment.appendChild(grid);
                        
                        const cancelButton = document.createElement('button');
                        cancelButton.textContent = 'Отмена';
                        cancelButton.style.cssText = \`
                            display: block;
                            margin: 24px auto 0;
                            background: #f44336;
                            color: white;
                            border: none;
                            padding: 12px 32px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-size: 16px;
                            font-weight: 500;
                            transition: background 0.15s;
                        \`;
                        
                        cancelButton.onclick = () => {
                            overlay.style.background = 'rgba(0, 0, 0, 0)';
                            dialog.style.transform = 'scale(0.9)';
                            dialog.style.opacity = '0';
                            setTimeout(() => {
                                overlay.remove();
                                callback(null);
                            }, 200);
                        };
                        
                        fragment.appendChild(cancelButton);
                        
                        dialog.appendChild(fragment);
                        overlay.appendChild(dialog);
                        document.body.appendChild(overlay);
                        
                        requestAnimationFrame(() => {
                            overlay.style.background = 'rgba(0, 0, 0, 0.85)';
                            overlay.style.backdropFilter = 'blur(5px)';
                            dialog.style.transform = 'scale(1)';
                            dialog.style.opacity = '1';
                        });
                    });
                }

                // Мониторинг состояния
                setInterval(() => {
                    if (window.__interceptorFlag === true) {
                        return;
                    }
                    
                    if (window.isScreenShareActive) {
                        let isStillSharing = false;
                        try {
                            if (window.APP?.conference?.getLocalTracks) {
                                const tracks = window.APP.conference.getLocalTracks();
                                isStillSharing = tracks.some(track => track.videoType === 'desktop');
                            }
                        } catch (e) {}
                        
                        const hasLiveStream = window.jitsiNativeMediaStream && 
                                            window.jitsiNativeMediaStream.getTracks().some(t => t.readyState === 'live');
                        
                        if (!isStillSharing && !hasLiveStream) {
                            console.log('[Monitor] Auto-cleanup: no active desktop track or stream');
                            
                            window.isScreenShareActive = false;
                            window.isNativeActive = false;
                            window.__interceptorFlag = false;
                            
                            if (window.jitsiNativeMediaStream) {
                                window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                    track.stop();
                                });
                                window.jitsiNativeMediaStream = null;
                            }
                        }
                    }
                }, 3000);
                
                // Ждем загрузки Jitsi API
                function waitForJitsiAPI() {
                    return new Promise((resolve) => {
                        if (window.JitsiMeetScreenObtainer?.openDesktopPicker) {
                            resolve(true);
                            return;
                        }
                        
                        let attempts = 0;
                        const checkInterval = setInterval(() => {
                            attempts++;
                            if (window.JitsiMeetScreenObtainer?.openDesktopPicker) {
                                clearInterval(checkInterval);
                                resolve(true);
                            } else if (attempts > 100) {
                                clearInterval(checkInterval);
                                resolve(false);
                            }
                        }, 50);
                    });
                }
                
                waitForJitsiAPI().then(ready => {
                    if (!ready) return;
                    
                    const originalOpenDesktopPicker = window.JitsiMeetScreenObtainer.openDesktopPicker;
                    
                    window.JitsiMeetScreenObtainer.openDesktopPicker = async function(options, callback) {
                        console.log('[JitsiManager] Desktop picker intercepted - NATIVE MODE ONLY');
                        
                        if (window.__interceptorFlag === true) {
                            console.log('[JitsiManager] Already processing, skipping');
                            return;
                        }
                        
                        // Проверка на активную демонстрацию
                        let isAlreadySharing = false;
                        try {
                            if (window.APP?.conference?.getLocalTracks) {
                                const tracks = window.APP.conference.getLocalTracks();
                                isAlreadySharing = tracks.some(track => track.videoType === 'desktop');
                            }
                        } catch (e) {}
                        
                        if (isAlreadySharing) {
                            console.log('[JitsiManager] Already sharing, stopping first');
                            try {
                                if (window.APP?.conference?.toggleScreenSharing) {
                                    await window.APP.conference.toggleScreenSharing();
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                }
                            } catch (e) {
                                console.error('[JitsiManager] Error stopping share:', e);
                            }
                            
                            window.isScreenShareActive = false;
                            window.isNativeActive = false;
                            window.__interceptorFlag = false;
                            
                            if (window.jitsiNativeMediaStream) {
                                window.jitsiNativeMediaStream.getTracks().forEach(track => track.stop());
                                window.jitsiNativeMediaStream = null;
                            }
                            
                            console.log('[JitsiManager] Previous share stopped');
                            return;
                        }
                        
                        window.__interceptorFlag = true;

                        // Сохраняем микрофон
                        window.__savedMicrophoneTrack = null;
                        try {
                            if (window.APP?.conference?.getLocalTracks) {
                                const tracks = window.APP.conference.getLocalTracks();
                                const micTrack = tracks.find(t => t.type === 'audio' && t.videoType !== 'desktop');
                                if (micTrack) {
                                    window.__savedMicrophoneTrack = micTrack;
                                    window.__microphoneMuted = micTrack.isMuted();
                                    console.log('[JitsiManager] Saved microphone track, muted:', window.__microphoneMuted);
                                }
                            }
                        } catch (e) {
                            console.warn('[JitsiManager] Could not save microphone:', e);
                        }
                        
                        try {
                            // СРАЗУ показываем выбор источников (без выбора режима звука)
                            const sources = await getElectronSourcesWithCache();
                            
                            showSourcePicker(sources, async (selectedId) => {
                                if (!selectedId) {
                                    window.__interceptorFlag = false;
                                    console.log('[JitsiManager] User cancelled source selection');
                                    return;
                                }
                                
                                try {
                                    // Сохраняем выбранный источник
                                    await window.ipcRenderer.invoke('jitsi:save-selected-source', selectedId);
                                    
                                    // Создаем нативный поток
                                    const streamResult = await window.ipcRenderer.invoke('create-native-stream-for-jitsi');
                                    
                                    if (!streamResult.success) {
                                        console.error('[JitsiManager] Stream creation failed');
                                        window.__interceptorFlag = false;
                                        return;
                                    }
                                    
                                    // Ждем готовности потока
                                    let attempts = 0;
                                    const maxAttempts = 50;
                                    let streamReady = false;

                                    while (attempts < maxAttempts) {
                                        attempts++;
                                        
                                        if (window.jitsiNativeMediaStream && 
                                            window.jitsiNativeMediaStream.getTracks && 
                                            window.jitsiNativeMediaStream.getTracks().length > 0) {
                                            
                                            const tracks = window.jitsiNativeMediaStream.getTracks();
                                            const allTracksLive = tracks.every(t => t.readyState === 'live');
                                            
                                            if (allTracksLive) {
                                                streamReady = true;
                                                console.log('[JitsiManager] Stream ready with', tracks.length, 'tracks');
                                                break;
                                            }
                                        }
                                        
                                        await new Promise(r => setTimeout(r, 50));
                                    }
                                    
                                    if (!streamReady) {
                                        console.error('[JitsiManager] Stream timeout after', attempts, 'attempts');
                                        window.__interceptorFlag = false;
                                        return;
                                    }
                                    
                                    console.log('[JitsiManager] Native stream confirmed ready');
                                    window.isScreenShareActive = true;
                                    
                                    // Вызываем callback
                                    if (callback) {
                                        setTimeout(() => {
                                            console.log('[JitsiManager] Calling Jitsi callback');
                                            callback('native:' + selectedId, { 
                                                audio: true, 
                                                screenShareAudio: true 
                                            });
                                            
                                            setTimeout(() => {
                                                window.__interceptorFlag = false;
                                            }, 1000);
                                        }, 100);
                                    }
                                    
                                    // Восстановление микрофона
                                    setTimeout(async () => {
                                        window.__interceptorFlag = false;
                                        
                                        try {
                                            const tracks = window.APP.conference.getLocalTracks();
                                            const hasMic = tracks.some(t => 
                                                t.type === 'audio' && 
                                                t.videoType !== 'desktop'
                                            );
                                            
                                            if (!hasMic) {
                                                console.log('[JitsiManager] Microphone missing, creating new...');
                                                
                                                const audioTracks = await window.JitsiMeetJS.createLocalTracks({
                                                    devices: ['audio']
                                                });
                                                
                                                if (audioTracks && audioTracks[0]) {
                                                    await window.APP.conference.addTrack(audioTracks[0]);
                                                    
                                                    if (window.__microphoneMuted) {
                                                        await audioTracks[0].mute();
                                                    }
                                                    
                                                    console.log('[JitsiManager] New microphone added');
                                                }
                                            }
                                        } catch (e) {
                                            console.error('[JitsiManager] Error checking/restoring mic:', e);
                                        }
                                        
                                        window.__savedMicrophoneTrack = null;
                                        window.__microphoneMuted = null;
                                    }, 3000);
                                    
                                } catch (error) {
                                    console.error('[JitsiManager] Error in native mode:', error);
                                    window.__interceptorFlag = false;
                                }
                            });
                            
                        } catch (error) {
                            console.error('[JitsiManager] Error in picker:', error);
                            window.__interceptorFlag = false;
                        }
                    };
                });
                
                return { success: true };
            })();
        `;
    }

    // Остальные методы остаются без изменений (кроме удаления упоминаний о стандартном режиме)
    async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        log.info("[JITSI-NATIVE-MANAGER] Starting native stream injection");
        
        if (this.state.isStreamActive) {
            log.warn("[JITSI-NATIVE-MANAGER] Stream already active, resetting...");
            await this.cleanup();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[JITSI-NATIVE-MANAGER] No active Jitsi window");
            return { success: false, error: "No active Jitsi window" };
        }

        try {
            const electronSourceId = this.state.lastSelectedSourceId;
            if (!electronSourceId) {
                log.error("[JITSI-NATIVE-MANAGER] No source selected");
                return { success: false, error: "No source selected" };
            }
            
            log.info(`[JITSI-NATIVE-MANAGER] Using Electron source: ${electronSourceId}`);
            
            // Запускаем Native аудио захват
            const audioResult = await this.startNativeAudioCapture(electronSourceId);
            if (!audioResult.success) {
                return { success: false, error: audioResult.error };
            }

            if (!this.state.window || this.state.window.isDestroyed()) {
                log.error("[JITSI-NATIVE-MANAGER] Window lost after audio capture start");
                await this.nativeCapture.stopCapture();
                return { success: false, error: "Window lost" };
            }
            
            // Создаем гибридный поток в Jitsi
            const streamResult = await this.createHybridStreamInJitsi(electronSourceId);

            if (!streamResult || !streamResult.success) {
                log.error("[JITSI-NATIVE-MANAGER] Failed to create hybrid stream:", streamResult);
                await this.nativeCapture.stopCapture();
                return { success: false, error: streamResult?.error || "Failed to create stream" };
            }

            // Настраиваем callbacks для аудио
            this.setupAudioCallbacks();
            
            this.state.isStreamActive = true;
            this.state.streamId = streamResult.streamId;
            
            log.info("[JITSI-NATIVE-MANAGER] Native stream injection successful");
            log.info(`[JITSI-NATIVE-MANAGER] Stream ID: ${streamResult.streamId}`);
            
            return streamResult;
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Error: ${error.message}`);
            await this.nativeCapture.stopCapture();
            return { success: false, error: error.message };
        }
    }

    // Остальные вспомогательные методы копируем без изменений
    private async startNativeAudioCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        log.info("[JITSI-NATIVE-MANAGER] Starting native audio capture");
        log.info(`[JITSI-NATIVE-MANAGER] Electron sourceId: ${sourceId}`);
        
        try {
            const nativeSourceId = await this.convertElectronToNativeId(sourceId);
            log.info(`[JITSI-NATIVE-MANAGER] Converted to native ID: ${nativeSourceId}`);
            
            const result = await this.nativeCapture.startAudioOnlyCapture(nativeSourceId);
            
            if (result.success) {
                log.info("[JITSI-NATIVE-MANAGER] ✅ Audio-only capture started");
            } else {
                log.error(`[JITSI-NATIVE-MANAGER] ❌ Audio-only capture failed: ${result.error}`);
            }
            
            return result;
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] startNativeAudioCapture ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async convertElectronToNativeId(electronSourceId: string): Promise<string> {
        log.info(`[CONVERT-ID] Converting Electron ID: ${electronSourceId}`);
        
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
        
        log.warn(`[CONVERT-ID] Unknown format, returning as-is: ${electronSourceId}`);
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

    // Копируем остальные методы без изменений
    private async createHybridStreamInJitsi(electronSourceId: string): Promise<any> {
        log.info(`[STREAM-ELECTRON] >>> createHybridStreamInJitsi: ${electronSourceId}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] No window");
            return { success: false, error: "No window" };
        }
        
        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    const isWindows = ${this.isWindowsPlatform()};
                    window.__creatingHybridStream = true;
                    console.log('[HYBRID] Creating hybrid stream, platform:', isWindows ? 'Windows' : 'macOS');
                    
                    try {
                        // ВАЖНО: Полная очистка перед созданием нового потока
                        // Очищаем ВСЕ старые ресурсы
                        if (window.jitsiNativeMediaStream) {
                            window.jitsiNativeMediaStream.getTracks().forEach(track => {
                                track.stop();
                                console.log('[HYBRID] Stopped old track:', track.kind);
                            });
                            window.jitsiNativeMediaStream = null;
                        }

                        // ОЧИЩАЕМ СТАРЫЕ БУФЕРЫ ДЕМОНСТРАЦИИ
                        if (window.screenShareLeftBuffer || window.screenShareRightBuffer) {
                            console.log('[HYBRID] Cleaning old screen share buffers...');
                            window.screenShareLeftBuffer = null;
                            window.screenShareRightBuffer = null;
                            window.leftRingBuffer = null;
                            window.rightRingBuffer = null;
                        }
                        
                        // Закрываем старый контекст демонстрации если есть
                        if (window.screenShareAudioContext) {
                            console.log('[HYBRID] Closing old screen share audio context...');
                            try {
                                await window.screenShareAudioContext.close();
                            } catch (e) {
                                console.warn('[HYBRID] Error closing old context:', e);
                            }
                            window.screenShareAudioContext = null;
                        }

                        window.isNativeActive = false;
                        window.isScreenShareActive = false;

                        class ParticipantAudioMixer {
                            constructor(sampleRate = 48000) {
                                this.sampleRate = sampleRate;
                                this.participants = new Map();
                                this.mixBuffer = new Float32Array(2048);
                            }
                            
                            addParticipantAudio(participantId, audioData) {
                                if (!this.participants.has(participantId)) {
                                    this.participants.set(participantId, {
                                        buffer: new RingBuffer(this.sampleRate),
                                        volume: 1.0,
                                        muted: false
                                    });
                                }
                                
                                const participant = this.participants.get(participantId);
                                participant.buffer.write(audioData);
                            }
                            
                            getMixedOutput(outputSize = 2048) {
                                const output = new Float32Array(outputSize);
                                
                                // Микшируем все голоса участников
                                this.participants.forEach(participant => {
                                    if (!participant.muted && participant.buffer.availableSamples > 0) {
                                        const temp = new Float32Array(outputSize);
                                        participant.buffer.read(temp);
                                        
                                        for (let i = 0; i < outputSize; i++) {
                                            output[i] += temp[i] * participant.volume;
                                        }
                                    }
                                });
                                
                                // Нормализация чтобы избежать клиппинга
                                const maxVal = Math.max(...output.map(Math.abs));
                                if (maxVal > 1.0) {
                                    const scale = 0.95 / maxVal;
                                    for (let i = 0; i < output.length; i++) {
                                        output[i] *= scale;
                                    }
                                }
                                
                                return output;
                            }
                            
                            setParticipantVolume(participantId, volume) {
                                if (this.participants.has(participantId)) {
                                    this.participants.get(participantId).volume = volume;
                                }
                            }
                            
                            muteParticipant(participantId, muted) {
                                if (this.participants.has(participantId)) {
                                    this.participants.get(participantId).muted = muted;
                                }
                            }
                            
                            clear() {
                                this.participants.forEach(participant => {
                                    if (participant.buffer && participant.buffer.clear) {
                                        participant.buffer.clear();
                                    }
                                });
                                this.participants.clear();
                            }
                        }
                        
                        // Создаем глобальный микшер для участников
                        window.participantAudioMixer = new ParticipantAudioMixer();
                        console.log('[HYBRID] Participant audio mixer created');
                        // ============ КОНЕЦ КЛАССА МИКШЕРА ============
                        
                        // 1. Получаем VIDEO от Electron
                        console.log('[HYBRID] Getting video stream...');
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

                        window.jitsiNativeMediaStream = videoStream; // Временно сохраняем видео-поток
                        window.isNativeActive = true;
                        
                        const videoTrack = videoStream.getVideoTracks()[0];
                        if (!videoTrack) {
                            throw new Error('No video track');
                        }
                        console.log('[HYBRID] Got video track');
                        
                        // 2. Создаем ОТДЕЛЬНЫЙ AUDIO контекст для демонстрации
                        console.log('[HYBRID] Creating screen share audio context...');
                        const screenShareAudioContext = new AudioContext({ 
                            sampleRate: 48000, 
                            latencyHint: 'interactive' 
                        });
                        
                        // ВАЖНО: Сохраняем контекст отдельно
                        window.screenShareAudioContext = screenShareAudioContext;
                        
                        const scriptProcessor = screenShareAudioContext.createScriptProcessor(2048, 0, 2);
                        
                        // 3. Создаем буферы для демонстрации
                        console.log('[HYBRID] Creating screen share ring buffers...');
                        
                        class RingBuffer {
                            constructor(size) {
                                this.buffer = new Float32Array(size);
                                this.writeIndex = 0;
                                this.readIndex = 0;
                                this.availableSamples = 0;
                                this.size = size;
                                console.log('[RingBuffer] Created with size:', size);
                            }
                            
                            write(data) {
                                let written = 0;
                                for (let i = 0; i < data.length && written < this.size; i++) {
                                    this.buffer[this.writeIndex] = data[i];
                                    this.writeIndex = (this.writeIndex + 1) % this.size;
                                    this.availableSamples = Math.min(this.availableSamples + 1, this.size);
                                    written++;
                                }
                                return written;
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
                            
                            clear() {
                                this.buffer.fill(0);
                                this.writeIndex = 0;
                                this.readIndex = 0;
                                this.availableSamples = 0;
                            }
                        }
                        
                        // СОЗДАЕМ БУФЕРЫ С УНИКАЛЬНЫМИ ИМЕНАМИ ДЛЯ ДЕМОНСТРАЦИИ
                        window.screenShareLeftBuffer = new RingBuffer(48000);
                        window.screenShareRightBuffer = new RingBuffer(48000);
                        
                        // Для совместимости сохраняем также под старыми именами
                        window.leftRingBuffer = window.screenShareLeftBuffer;
                        window.rightRingBuffer = window.screenShareRightBuffer;
                        
                        console.log('[HYBRID] Screen share buffers created:', {
                            left: !!window.screenShareLeftBuffer,
                            right: !!window.screenShareRightBuffer
                        });
                        
                        // 4. Настраиваем обработку аудио
                        scriptProcessor.onaudioprocess = (event) => {
                            if (!window.isScreenShareActive) {
                                event.outputBuffer.getChannelData(0).fill(0);
                                event.outputBuffer.getChannelData(1).fill(0);
                                return;
                            }
                            
                            const leftChannel = event.outputBuffer.getChannelData(0);
                            const rightChannel = event.outputBuffer.getChannelData(1);
                            
                            // Сначала читаем системный звук
                            if (window.screenShareLeftBuffer && window.screenShareRightBuffer) {
                                window.screenShareLeftBuffer.read(leftChannel);
                                window.screenShareRightBuffer.read(rightChannel);
                            }
                            
                            // НОВОЕ: Микшируем голоса участников если есть
                            if (window.participantAudioMixer && window.audioRoutingMode === 'presenter_mix') {
                                const participantMix = window.participantAudioMixer.getMixedOutput(leftChannel.length);
                                
                                // Микшируем с системным звуком (70% системный, 30% голоса)
                                for (let i = 0; i < leftChannel.length; i++) {
                                    leftChannel[i] = leftChannel[i] * 0.7 + participantMix[i] * 0.3;
                                    rightChannel[i] = rightChannel[i] * 0.7 + participantMix[i] * 0.3;
                                }
                            }
                        };
                        
                        const destination = screenShareAudioContext.createMediaStreamDestination();
                        scriptProcessor.connect(destination);
                        
                        // 5. Создаем поток для демонстрации
                        const screenShareStream = new MediaStream();
                        screenShareStream.addTrack(videoTrack);
                        
                        if (destination.stream.getAudioTracks().length > 0) {
                            const audioTrack = destination.stream.getAudioTracks()[0];
                            // Помечаем трек как трек демонстрации
                            audioTrack.contentHint = 'screenshare';
                            screenShareStream.addTrack(audioTrack);
                            console.log('[HYBRID] Added screen share audio track');
                        }
                        
                        // 6. Сохраняем с пометками о демонстрации
                        window.jitsiNativeMediaStream = screenShareStream;
                        window.screenShareStream = screenShareStream; // Дополнительная ссылка
                        window.nativeAudioContext = screenShareAudioContext; // Для совместимости
                        window.isNativeActive = true;
                        window.isScreenShareActive = true; // ВАЖНЫЙ ФЛАГ
                        window.isHybridMode = true;
                        window.audioCounter = 0;
                        
                        // Сохраняем ID видео трека для последующей проверки
                        window.screenShareVideoTrackId = videoTrack.id;
                        
                        // 7. Запускаем audio context
                        if (screenShareAudioContext.state === 'suspended') {
                            await screenShareAudioContext.resume();
                            console.log('[HYBRID] Screen share audio context resumed');
                        }
                        
                        // ДОБАВЛЯЕМ ОБРАБОТЧИК ОСТАНОВКИ ТРЕКА
                        videoTrack.addEventListener('ended', async () => {
                            console.log('[HYBRID] Video track ended, cleaning up screen share...');
                            
                            // Очищаем микшер участников
                            if (window.participantAudioMixer) {
                                window.participantAudioMixer.clear();
                                window.participantAudioMixer = null;
                            }


                            // Очищаем только ресурсы демонстрации
                            if (window.screenShareAudioContext) {
                                try {
                                    await window.screenShareAudioContext.close();
                                } catch (e) {
                                    console.warn('[HYBRID] Error closing audio context:', e);
                                }
                                window.screenShareAudioContext = null;
                            }
                            
                            // Очищаем буферы демонстрации
                            if (window.screenShareLeftBuffer) {
                                window.screenShareLeftBuffer.clear();
                                window.screenShareLeftBuffer = null;
                            }
                            if (window.screenShareRightBuffer) {
                                window.screenShareRightBuffer.clear();
                                window.screenShareRightBuffer = null;
                            }
                            
                            window.leftRingBuffer = null;
                            window.rightRingBuffer = null;
                            window.isScreenShareActive = false;
                            window.isNativeActive = false;
                            
                            console.log('[HYBRID] Screen share cleanup completed');
                        });
                        
                        // ФИНАЛЬНАЯ ПРОВЕРКА
                        const finalCheck = {
                            success: true,
                            streamId: screenShareStream.id,
                            hasVideo: screenShareStream.getVideoTracks().length > 0,
                            hasAudio: screenShareStream.getAudioTracks().length > 0,
                            hasLeftBuffer: !!window.screenShareLeftBuffer,
                            hasRightBuffer: !!window.screenShareRightBuffer,
                            contextState: screenShareAudioContext.state,
                            isScreenShare: true
                        };
                        
                        console.log('[HYBRID] ✅ Screen share stream created:', finalCheck);
                        return finalCheck;
                        
                    } catch (error) {
                        console.error('[HYBRID] Error:', error);

                        // Очистка при ошибке
                        if (window.participantAudioMixer) {
                            window.participantAudioMixer.clear();
                            window.participantAudioMixer = null;
                        }
                        
                        // Очистка при ошибке
                        if (window.screenShareAudioContext) {
                            try {
                                await window.screenShareAudioContext.close();
                            } catch (e) {}
                            window.screenShareAudioContext = null;
                        }
                        
                        return { success: false, error: error.message };
                    }
                })();
            `);
            
            // НОВОЕ: Уведомление о начале демонстрации
            await this.notifyScreenShareStart();
            
            // НОВОЕ: Настройка приватных каналов
            await this.setupPrivateAudioChannels();

            log.info(`[STREAM-ELECTRON] Hybrid stream result:`, result);

            // Только если поток создан успешно
            if (result && result.success) {
                // ИСПРАВЛЕННЫЙ код уведомления
                await this.notifyScreenShareStart();
            }

            return result;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] createHybridStreamInJitsi ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async notifyScreenShareStart(): Promise<void> {
            if (!this.state.window || this.state.window.isDestroyed()) return;
            
            try {
                await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        if (window.APP?.conference?._room) {
                            const room = window.APP.conference._room;
                            
                            // Получаем ID пользователя
                            const myId = room.myUserId ? room.myUserId() : 'unknown';
                            console.log('[PRESENTER] My user ID:', myId);
                            
                            // ИСПРАВЛЕНО: используем room.sendCommand вместо conference.sendCommand
                            if (room.sendCommand) {
                                room.sendCommand('SCREEN_SHARE_STARTED', {
                                    value: JSON.stringify({
                                        presenterId: myId,
                                        timestamp: Date.now(),
                                        audioMode: 'system_capture'
                                    })
                                });
                                console.log('[PRESENTER] Command sent to all participants');
                            } else {
                                console.warn('[PRESENTER] sendCommand not available');
                            }
                            
                            window.audioRoutingMode = 'presenter_mix';
                            window.isPresenter = true;
                        } else {
                            console.warn('[PRESENTER] Conference room not available');
                        }
                        return true;
                    })();
                `);
            } catch (error: any) {
                log.error(`[STREAM-ELECTRON] notifyScreenShareStart error: ${error.message}`);
            }
    }


    private async setupPrivateAudioChannels(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        await this.state.window.webContents.executeJavaScript(`
            (function() {
                // ИСПРАВЛЕНО: используем правильные события через JitsiMeetJS.events
                if (window.APP?.conference?._room && window.JitsiMeetJS?.events?.track) {
                    const room = window.APP.conference._room;
                    
                    // Подписываемся на события треков
                    room.on(
                        window.JitsiMeetJS.events.track.TRACK_ADDED,
                        (track) => {
                            // Если мы демонстрируем и это аудио трек от участника
                            if (window.audioRoutingMode === 'presenter_mix' && 
                                track.getType() === 'audio' &&
                                track.getParticipantId() !== room.myUserId()) {
                                
                                console.log('[PRESENTER] Participant audio track added:', track.getParticipantId());
                                handleParticipantAudio(track);
                            }
                        }
                    );
                    
                    console.log('[PRESENTER] Private audio channels handler installed');
                } else {
                    console.warn('[PRESENTER] Cannot setup audio channels - API not ready');
                }
                
                function handleParticipantAudio(track) {
                    const participantId = track.getParticipantId();
                    console.log('[PRESENTER] Handling audio from participant:', participantId);
                    
                    // Создаем контекст для обработки аудио участника
                    try {
                        const stream = new MediaStream([track.track]);
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        const source = audioContext.createMediaStreamSource(stream);
                        const processor = audioContext.createScriptProcessor(2048, 1, 1);
                        
                        source.connect(processor);
                        processor.connect(audioContext.destination);
                        
                        processor.onaudioprocess = (e) => {
                            if (window.participantAudioMixer && window.audioRoutingMode === 'presenter_mix') {
                                const inputData = e.inputBuffer.getChannelData(0);
                                window.participantAudioMixer.addParticipantAudio(participantId, inputData);
                            }
                        };
                        
                        // Сохраняем для управления
                        window.privateAudioProcessors = window.privateAudioProcessors || new Map();
                        window.privateAudioProcessors.set(participantId, {
                            context: audioContext,
                            processor: processor,
                            source: source
                        });
                        
                        console.log('[PRESENTER] Audio processor created for:', participantId);
                    } catch (error) {
                        console.error('[PRESENTER] Error handling participant audio:', error);
                    }
                }
            })();
        `);
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
        
        try {
            const arrayBuffer = audioData.data;
            // КРИТИЧНО: Разное количество сэмплов для разных платформ
            const samples = this.isWindowsPlatform() 
                ? (audioData.numSamples || 480)  // Windows: 480 samples
                : (audioData.numSamples || 960); // macOS: 960 samples
            const channels = audioData.channels || 2;
            
            // Проверка для отладки
            if (this.state.audioFrameCount === 1 || this.state.audioFrameCount % 100 === 0) {
                const float32 = new Float32Array(arrayBuffer);
                let maxAmp = 0;
                for (let i = 0; i < Math.min(100, float32.length); i++) {
                    maxAmp = Math.max(maxAmp, Math.abs(float32[i]));
                }
                log.info(`[AUDIO-CHECK] Frame ${this.state.audioFrameCount}: platform=${this.isWindowsPlatform() ? 'Windows' : 'macOS'}, samples=${samples}, bytes=${arrayBuffer.byteLength}, maxAmp=${maxAmp.toFixed(4)}`);
            }
            
            // КРИТИЧНО: Используем правильный метод декодирования для каждой платформы
            const { leftChannel, rightChannel } = this.isWindowsPlatform()
                ? this.decodeWindowsAudio(arrayBuffer, samples, channels)
                : this.decodeMacOSAudio(arrayBuffer, samples, channels);
            
            // Анализируем уровни
            const levels = this.analyzeAudioLevels(leftChannel, rightChannel);
            
            if (this.state.audioFrameCount % 50 === 0) {
                log.info(`[AUDIO] Frame ${this.state.audioFrameCount}: L=${levels.maxLeft.toFixed(4)}, R=${levels.maxRight.toFixed(4)}, hasAudio=${levels.hasAudio}`);
            }
            
            // Если нет звука, пропускаем нормализацию
            if (!levels.hasAudio) {
                log.warn(`[AUDIO] No audio detected in frame ${this.state.audioFrameCount}`);
            }
            
            const { processedLeft, processedRight } = this.normalizeAudio(
                leftChannel, 
                rightChannel, 
                levels
            );

            if (this.state.window && !this.state.window.isDestroyed()) {
                this.state.window.webContents.executeJavaScript(`
                (function() {
                    if (window.participantAudioMixer && window.audioRoutingMode === 'presenter_mix') {
                    // Получаем смикшированные голоса участников
                    const participantMix = window.participantAudioMixer.getMixedOutput();
                    
                    // Микшируем с системным звуком
                    // Это происходит в sendAudioToJitsi
                    window.pendingParticipantAudio = participantMix;
                    }
                })();
                `).catch(() => {});
            }
                        
            // Отправляем в Jitsi
            this.sendAudioToJitsi(processedLeft, processedRight, samples);
        } catch (error: any) {
            log.error(`[AUDIO] processNativeAudio ERROR: ${error.message}`);
        }
    }

    // ... остальные методы копируем без изменений
    
    // Методы для UI, загрузки, качества и т.д. остаются без изменений
    private async injectLoadingScreen(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        const loadingHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    
                    body {
                        background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1e 100%);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                        overflow: hidden;
                    }
                    
                    .loading-container {
                        text-align: center;
                        animation: fadeIn 0.5s ease-in;
                    }
                    
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(20px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    
                    .logo {
                        width: 80px;
                        height: 80px;
                        margin: 0 auto 30px;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        border-radius: 20px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 10px 40px rgba(102, 126, 234, 0.3);
                        animation: pulse 2s ease-in-out infinite;
                    }
                    
                    @keyframes pulse {
                        0%, 100% { transform: scale(1); }
                        50% { transform: scale(1.05); }
                    }
                    
                    .logo svg {
                        width: 50px;
                        height: 50px;
                        fill: white;
                    }
                    
                    .loading-text {
                        color: #ffffff;
                        font-size: 18px;
                        font-weight: 500;
                        margin-bottom: 20px;
                        letter-spacing: 0.5px;
                    }
                    
                    .loading-subtext {
                        color: #8892b0;
                        font-size: 14px;
                        margin-bottom: 40px;
                    }
                    
                    .spinner-container {
                        position: relative;
                        width: 50px;
                        height: 50px;
                        margin: 0 auto;
                    }
                    
                    .spinner {
                        width: 50px;
                        height: 50px;
                        border: 3px solid rgba(255, 255, 255, 0.1);
                        border-top-color: #667eea;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    }
                    
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                    
                    .progress-bar {
                        width: 250px;
                        height: 4px;
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 2px;
                        margin: 30px auto;
                        overflow: hidden;
                    }
                    
                    .progress-fill {
                        height: 100%;
                        background: linear-gradient(90deg, #667eea, #764ba2);
                        border-radius: 2px;
                        width: 0%;
                        /* Более реалистичная анимация прогресса - 7 секунд */
                        animation: progress 7s ease-out forwards;
                    }
                    
                    @keyframes progress {
                        0% { width: 0%; }
                        20% { width: 25%; }
                        40% { width: 45%; }
                        60% { width: 65%; }
                        80% { width: 85%; }
                        90% { width: 92%; }
                        100% { width: 98%; }
                    }
                    
                    .tips {
                        position: absolute;
                        bottom: 40px;
                        left: 50%;
                        transform: translateX(-50%);
                        color: #64748b;
                        font-size: 13px;
                        animation: tipChange 3s ease-in-out infinite;
                    }
                    
                    @keyframes tipChange {
                        0%, 100% { opacity: 0.6; }
                        50% { opacity: 1; }
                    }
                </style>
            </head>
            <body>
                <div class="loading-container">
                    <div class="logo">
                        <svg viewBox="0 0 24 24">
                            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                        </svg>
                    </div>
                    <div class="loading-text">Подключаемся к конференции</div>
                    <div class="loading-subtext" id="loading-status">Инициализация...</div>
                    <div class="spinner-container">
                        <div class="spinner"></div>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                </div>
                <div class="tips" id="loading-tips">Проверяем соединение...</div>
                
                <script>
                    // Меняем текст подсказок
                    const tips = [
                        'Проверяем соединение...',
                        'Загружаем интерфейс...',
                        'Настраиваем аудио и видео...',
                        'Подготавливаем конференцию...',
                        'Почти готово...'
                    ];
                    const statusTexts = [
                        'Инициализация...',
                        'Подключение к серверу...',
                        'Загрузка модулей...',
                        'Настройка параметров...',
                        'Финальная подготовка...'
                    ];
                    
                    let tipIndex = 0;
                    const tipsElement = document.getElementById('loading-tips');
                    const statusElement = document.getElementById('loading-status');
                    
                    setInterval(() => {
                        tipIndex = (tipIndex + 1) % tips.length;
                        tipsElement.style.opacity = '0';
                        setTimeout(() => {
                            tipsElement.textContent = tips[tipIndex];
                            tipsElement.style.opacity = '1';
                        }, 300);
                        
                        if (statusElement) {
                            statusElement.textContent = statusTexts[tipIndex];
                        }
                    }, 1500);
                </script>
            </body>
            </html>
        `;
        
        await this.state.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`);
    }
    
    private async waitForJitsiReady(): Promise<boolean> {
        if (!this.state.window || this.state.window.isDestroyed()) return false;
        
        let attempts = 0;
        const maxAttempts = 100; // 5 секунд максимум
        
        while (attempts < maxAttempts) {
            try {
                const isReady = await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        // Проверяем различные индикаторы готовности Jitsi
                        const checks = {
                            hasJitsiMeetJS: typeof JitsiMeetJS !== 'undefined',
                            hasAPP: typeof APP !== 'undefined',
                            hasConference: !!(window.APP && window.APP.conference),
                            hasRoom: !!(window.APP && window.APP.conference && window.APP.conference._room),
                            domReady: document.readyState === 'complete',
                            hasToolbar: !!document.querySelector('.toolbox-content-items'),
                            // Добавляем проверку видео элементов
                            hasVideoContainer: !!document.querySelector('#largeVideoContainer'),
                            // Проверяем что UI полностью загружен
                            hasUIElements: !!document.querySelector('.filmstrip') && 
                                        !!document.querySelector('.toolbox'),
                            // Проверяем что нет видимых лоадеров
                            noLoaders: !document.querySelector('.spinner') && 
                                    !document.querySelector('.loading')
                        };
                        
                        // Считаем готовым если основные компоненты загружены
                        const isReady = checks.hasJitsiMeetJS && 
                                checks.hasAPP && 
                                checks.hasConference &&
                                checks.domReady &&
                                checks.hasToolbar &&
                                checks.hasVideoContainer &&
                                checks.hasUIElements;
                        
                        console.log('[LOADING] Jitsi ready check:', checks, 'Ready:', isReady);
                        return isReady;
                    })();
                `);
                
                if (isReady) {
                    await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 секунды дополнительно
                    log.info("[JITSI-MANAGER] Jitsi is ready!");
                    return true;
                }
            } catch (error) {
                // Игнорируем ошибки во время загрузки
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        log.warn("[JITSI-MANAGER] Jitsi initialization timeout, proceeding anyway");
        return false;
    }

    private decodeWindowsAudio(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): { leftChannel: Float32Array; rightChannel: Float32Array } {
        
        const float32Data = new Float32Array(arrayBuffer);
        const leftChannel = new Float32Array(samples);
        const rightChannel = new Float32Array(samples);
        
        // Windows использует INTERLEAVED формат (L,R,L,R,L,R...)
        if (arrayBuffer.byteLength === samples * channels * 4) {
            // Interleaved формат
            for (let i = 0; i < samples; i++) {
                leftChannel[i] = float32Data[i * 2];
                rightChannel[i] = float32Data[i * 2 + 1];
            }
            
            // Проверка на валидность
            let hasData = false;
            for (let i = 0; i < Math.min(100, samples); i++) {
                if (Math.abs(leftChannel[i]) > 0.00001 || Math.abs(rightChannel[i]) > 0.00001) {
                    hasData = true;
                    break;
                }
            }
            
            if (!hasData) {
                log.warn("[AUDIO] No data in interleaved format, trying planar...");
                // Пробуем planar формат как fallback
                const halfSize = float32Data.length / 2;
                for (let i = 0; i < samples && i < halfSize; i++) {
                    leftChannel[i] = float32Data[i];
                    rightChannel[i] = float32Data[halfSize + i];
                }
            }
        } else {
            log.warn(`[AUDIO] Unexpected buffer size: ${arrayBuffer.byteLength} bytes for ${samples} samples`);
            // Пробуем прочитать как есть
            for (let i = 0; i < samples && i < float32Data.length / 2; i++) {
                leftChannel[i] = float32Data[i * 2] || 0;
                rightChannel[i] = float32Data[i * 2 + 1] || 0;
            }
        }
        
        return { leftChannel, rightChannel };
    }

    private decodeMacOSAudio(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): { leftChannel: Float32Array; rightChannel: Float32Array } {
        
        let leftChannel = new Float32Array(samples);
        let rightChannel = new Float32Array(samples);
        
        if (arrayBuffer.byteLength === samples * channels * 4) {
            // Float32 формат для macOS - ПЛАНАРНЫЙ формат
            const dataView = new DataView(arrayBuffer);
            
            // Планарный формат: сначала все левые сэмплы, потом все правые
            const halfSize = arrayBuffer.byteLength / 2;
            for (let i = 0; i < samples; i++) {
                leftChannel[i] = dataView.getFloat32(i * 4, true);
                rightChannel[i] = dataView.getFloat32(halfSize + i * 4, true);
            }
            
            // Проверка на валидность данных
            let hasData = false;
            for (let i = 0; i < samples; i++) {
                if (Math.abs(leftChannel[i]) > 0.00001 || Math.abs(rightChannel[i]) > 0.00001) {
                    hasData = true;
                    break;
                }
            }
            
            // Если планарный формат пустой, пробуем интерливд
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
        
        // Проверяем, что есть реальные данные перед отправкой
        let maxAmp = 0;
        for (let i = 0; i < Math.min(100, samples); i++) {
            maxAmp = Math.max(maxAmp, Math.abs(leftData[i]), Math.abs(rightData[i]));
        }
        
        if (this.state.audioFrameCount === 1 || this.state.audioFrameCount % 100 === 0) {
            log.info(`[SEND-TO-JITSI] Frame ${this.state.audioFrameCount}: maxAmp=${maxAmp.toFixed(4)}, samples=${samples}`);
        }
        
        // КРИТИЧНО: Для больших массивов используем более эффективный способ
        const jsCode = `
            (function() {
                if (!window.isNativeActive || !window.leftRingBuffer || !window.rightRingBuffer) {
                    console.log('[JITSI] Buffer not ready');
                    return;
                }
                
                try {
                    // Создаем типизированные массивы напрямую
                    const leftData = new Float32Array(${samples});
                    const rightData = new Float32Array(${samples});
                    
                    // Заполняем данными (ограничиваем первые 1000 сэмплов для производительности)
                    const leftSamples = [${Array.from(leftData.slice(0, Math.min(1000, samples))).join(',')}];
                    const rightSamples = [${Array.from(rightData.slice(0, Math.min(1000, samples))).join(',')}];
                    
                    for (let i = 0; i < Math.min(${samples}, leftSamples.length); i++) {
                        leftData[i] = leftSamples[i];
                        rightData[i] = rightSamples[i];
                    }
                    
                    // Проверка на стороне Jitsi
                    let maxAmp = 0;
                    for (let i = 0; i < Math.min(100, leftData.length); i++) {
                        maxAmp = Math.max(maxAmp, Math.abs(leftData[i]), Math.abs(rightData[i]));
                    }
                    
                    // НОВОЕ: Микшируем голоса участников если есть
                    if (window.participantAudioMixer && window.audioRoutingMode === 'presenter_mix') {
                        const participantMix = window.participantAudioMixer.getMixedOutput(${samples});
                        
                        // Микшируем с системным звуком
                        for (let i = 0; i < ${samples}; i++) {
                        leftData[i] = leftData[i] * 0.7 + participantMix[i] * 0.3;
                        rightData[i] = rightData[i] * 0.7 + participantMix[i] * 0.3;
                        }
                    }
                    
                    // Записываем в буферы как обычно
                    window.leftRingBuffer.write(leftData);
                    window.rightRingBuffer.write(rightData);
                    
                    window.audioCounter = (window.audioCounter || 0) + 1;
                    
                    if (window.audioCounter === 1) {
                        console.log('[JITSI] First audio in buffer! maxAmp:', maxAmp.toFixed(4));
                    }
                    
                    if (window.audioCounter % 100 === 0) {
                        const bufferMs = window.leftRingBuffer.availableSamples / 48;
                        console.log('[JITSI] Frame ' + window.audioCounter + 
                                ', buffer: ' + bufferMs.toFixed(0) + 'ms' + 
                                ', maxAmp: ' + maxAmp.toFixed(4));
                    }
                } catch (e) {
                    console.error('[JITSI] Error:', e);
                }
            })();
        `;
        
        this.state.window.webContents.executeJavaScript(jsCode).catch((err) => {
            log.error(`[SEND-TO-JITSI] Execute error: ${err.message}`);
        });
    }
    
    private async hideLoadingScreen(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    // Создаем элемент для плавного перехода
                    const fadeOverlay = document.createElement('div');
                    fadeOverlay.style.cssText = \`
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: #1a1a2e;
                        z-index: 999999;
                        transition: opacity 0.8s ease-out;
                        pointer-events: none;
                    \`;
                    document.body.appendChild(fadeOverlay);
                    
                    // Более плавное скрытие
                    setTimeout(() => {
                        fadeOverlay.style.opacity = '0';
                        setTimeout(() => {
                            fadeOverlay.remove();
                        }, 800); // Совпадает с временем transition
                    }, 200); // Небольшая задержка перед началом
                    
                    console.log('[LOADING] Loading screen hidden with smooth transition');
                })();
            `);
        } catch (error) {
            log.error("[JITSI-MANAGER] Error hiding loading screen:", error);
        }
    }
    
    private async injectDebugOverlay(): Promise<void> {
        log.info("[JITSI-MANAGER] Injecting debug indicator with quality controls...");
        
        if (!this.config.enableDebugUI) {
            return;
        }
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            return;
        }
        
        // Проверяем доступность нативного плагина
        const nativeAvailable = this.nativeCapture && this.nativeCapture.isNativeAvailable();
        const showQualityControls = nativeAvailable && !this.useStandardJitsi;
        
        log.info(`[JITSI-MANAGER] Native available: ${nativeAvailable}, Show quality controls: ${showQualityControls}`);
        
        try {
            // Проверяем, не инъектировано ли уже
            const alreadyInjected = await this.state.window.webContents.executeJavaScript(`
                !!(document.getElementById('native-debug-indicator'))
            `);
            
            if (alreadyInjected) {
                return;
            }
            
            // ШАГ 1: Добавляем стили
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    const style = document.createElement('style');
                    style.id = 'debug-indicator-styles';
                    style.textContent = \`
                        @keyframes pulse {
                            0% { opacity: 1; }
                            50% { opacity: 0.5; }
                            100% { opacity: 1; }
                        }
                        @keyframes slideIn {
                            from { transform: translateX(-100%); opacity: 0; }
                            to { transform: translateX(0); opacity: 1; }
                        }
                        @keyframes slideOut {
                            from { transform: translateX(0); opacity: 1; }
                            to { transform: translateX(-100%); opacity: 0; }
                        }
                        #quality-preset option {
                            background: #222;
                            color: white;
                        }
                        input[type="number"]::-webkit-inner-spin-button,
                        input[type="number"]::-webkit-outer-spin-button {
                            opacity: 1;
                            height: 20px;
                        }
                        #apply-custom:hover {
                            background: #45a049 !important;
                        }
                        #quality-toggle:hover {
                            color: rgba(255,255,255,1) !important;
                        }
                        .status-badge {
                            padding: 2px 6px;
                            border-radius: 4px;
                            font-size: 10px;
                            font-weight: bold;
                            color: white;
                            margin-left: 8px;
                        }
                        .native-mode { background: #4CAF50; }
                        .standard-mode { background: #FF9800; }
                        .error-mode { background: #f44336; }
                        #native-audio-toggle {
                            width: 16px;
                            height: 16px;
                            position: relative;
                            -webkit-appearance: none;
                            appearance: none;
                            background: rgba(255,255,255,0.2);
                            border-radius: 3px;
                            outline: none;
                            cursor: pointer;
                            transition: background 0.3s;
                        }
                        
                        #native-audio-toggle:checked {
                            background: #4CAF50;
                        }
                        
                        #native-audio-toggle:checked::after {
                            content: '✓';
                            position: absolute;
                            color: white;
                            font-size: 12px;
                            top: -2px;
                            left: 2px;
                        }
                        
                        #native-audio-toggle:hover {
                            background: rgba(255,255,255,0.3);
                        }
                        
                        #native-audio-toggle:checked:hover {
                            background: #45a049;
                        }
                    \`;
                    document.head.appendChild(style);
                    return true;
                })();
            `);
            
            // ШАГ 2: Создаем HTML структуру - передаем параметры через переменные
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    // Получаем параметры
                    const showQualityControls = ${showQualityControls};
                    const nativeAvailable = ${nativeAvailable};
                    
                    console.log('[DEBUG] Creating indicator - showQualityControls:', showQualityControls, 'nativeAvailable:', nativeAvailable);
                    
                    // Удаляем старые элементы
                    const oldIndicator = document.getElementById('native-debug-indicator');
                    if (oldIndicator) oldIndicator.remove();
                    
                    const container = document.createElement('div');
                    container.id = 'native-debug-indicator';
                    container.style.cssText = 'position: fixed; top: 15px; left: 15px; z-index: 999999;';
                    
                    // Создаем индикатор бар
                    const indicatorBar = document.createElement('div');
                    indicatorBar.id = 'indicator-bar';
                    indicatorBar.style.cssText = 'display: flex; gap: 8px; padding: 6px 10px; background: rgba(0, 0, 0, 0.6); border-radius: 15px; align-items: center; backdrop-filter: blur(8px); transition: opacity 0.3s; margin-bottom: 8px;';
                    
                    // Точка для плагина
                    const pluginDot = document.createElement('div');
                    pluginDot.id = 'plugin-dot';
                    pluginDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: ' + (nativeAvailable ? '#4CAF50' : '#f44336') + '; transition: background 0.3s; box-shadow: 0 0 3px rgba(0,0,0,0.2);';
                    pluginDot.title = 'Plugin Status: ' + (nativeAvailable ? 'Available' : 'Not Available');
                    
                    // Точка для аудио
                    const audioDot = document.createElement('div');
                    audioDot.id = 'audio-dot';
                    audioDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #2196F3; transition: background 0.3s; box-shadow: 0 0 3px rgba(0,0,0,0.2);';
                    audioDot.title = 'Audio Status';
                    
                    indicatorBar.appendChild(pluginDot);
                    indicatorBar.appendChild(audioDot);
                    
                    // Добавляем элементы управления качеством только если плагин доступен
                    if (showQualityControls) {
                        // Разделитель
                        const separator = document.createElement('div');
                        separator.style.cssText = 'width: 1px; height: 12px; background: rgba(255,255,255,0.2); margin: 0 4px;';
                        
                        // Кнопка настроек
                        const qualityToggle = document.createElement('button');
                        qualityToggle.id = 'quality-toggle';
                        qualityToggle.style.cssText = 'background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer; padding: 0; font-size: 12px; transition: color 0.2s;';
                        qualityToggle.title = 'Quality Settings';
                        qualityToggle.textContent = '⚙️';
                        
                        indicatorBar.appendChild(separator);
                        indicatorBar.appendChild(qualityToggle);
                    } else {
                        // Добавляем индикатор режима для standard mode
                        const modeIndicator = document.createElement('span');
                        modeIndicator.className = 'status-badge standard-mode';
                        modeIndicator.textContent = 'STANDARD';
                        modeIndicator.title = 'Using standard Jitsi (no quality controls)';
                        indicatorBar.appendChild(modeIndicator);
                    }

                    // Добавляем индикатор текущего режима (только для чтения)
                    const audioModeIndicator = document.createElement('div');
                    audioModeIndicator.id = 'audio-mode-indicator';
                    audioModeIndicator.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-left: 8px;';
                    
                    const audioModeIcon = document.createElement('span');
                    audioModeIcon.style.cssText = 'font-size: 10px;';
                    audioModeIcon.textContent = '🔊';
                    
                    const audioModeText = document.createElement('span');
                    audioModeText.id = 'audio-mode-text';
                    audioModeText.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.7);';
                    audioModeText.textContent = ${this.state.useNativeAudio} ? 'Native' : 'Standard';
                    
                    audioModeIndicator.appendChild(audioModeIcon);
                    audioModeIndicator.appendChild(audioModeText);
                    
                    indicatorBar.appendChild(audioModeIndicator);
                    
                    container.appendChild(indicatorBar);
                    document.body.appendChild(container);
                    
                    console.log('[DEBUG] Indicator bar created');
                    return true;
                })();
            `);
            
            // ШАГ 3: Создаем панель качества ТОЛЬКО если нативный плагин доступен
            if (showQualityControls) {
                await this.state.window.webContents.executeJavaScript(`
                    (function() {
                        const container = document.getElementById('native-debug-indicator');
                        if (!container) {
                            console.error('[DEBUG] Container not found for quality panel');
                            return false;
                        }
                        
                        const qualityPanel = document.createElement('div');
                        qualityPanel.id = 'quality-panel';
                        qualityPanel.style.cssText = 'display: none; background: rgba(0, 0, 0, 0.85); border-radius: 12px; padding: 12px; backdrop-filter: blur(10px); min-width: 200px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
                        
                        // Заголовок
                        const title = document.createElement('div');
                        title.style.cssText = 'color: #fff; font-size: 11px; margin-bottom: 10px; font-family: system-ui;';
                        title.textContent = 'Качество трансляции';
                        
                        // Селектор качества
                        const select = document.createElement('select');
                        select.id = 'quality-preset';
                        select.style.cssText = 'width: 100%; padding: 6px; border-radius: 6px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px; margin-bottom: 8px; cursor: pointer;';
                        
                        const options = [
                            ['ULTRALOW', 'Очень низкое (320x240 @ 15fps)'],
                            ['LOW', 'Низкое (640x480 @ 15fps)'],
                            ['MEDIUM', 'Среднее (1280x720 @ 10fps)', true],
                            ['HIGH', 'Высокое (1920x1080 @ 30fps)'],
                            ['ULTRAHIGH', 'Ультра (2560x1440 @ 30fps)'],
                            ['PRESENTATION', 'Презентация (1920x1080 @ 5fps)'],
                            ['SCREENSHARE', 'Демонстрация (1920x1080 @ 15fps)'],
                            ['CUSTOM', '➤ Настроить...']
                        ];
                        
                        options.forEach(([value, text, selected]) => {
                            const option = document.createElement('option');
                            option.value = value;
                            option.textContent = text;
                            option.style.background = '#222';
                            if (selected) option.selected = true;
                            select.appendChild(option);
                        });
                        
                        // Кастомные настройки
                        const customSettings = document.createElement('div');
                        customSettings.id = 'custom-settings';
                        customSettings.style.cssText = 'display: none;';
                        
                        const customInner = document.createElement('div');
                        customInner.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.1); margin: 8px 0; padding-top: 8px;';
                        
                        // Строка с width и height
                        const sizeRow = document.createElement('div');
                        sizeRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 6px;';
                        
                        const widthInput = document.createElement('input');
                        widthInput.id = 'custom-width';
                        widthInput.type = 'number';
                        widthInput.placeholder = 'Ширина';
                        widthInput.min = '320';
                        widthInput.max = '3840';
                        widthInput.style.cssText = 'flex: 1; padding: 4px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px;';
                        
                        const heightInput = document.createElement('input');
                        heightInput.id = 'custom-height';
                        heightInput.type = 'number';
                        heightInput.placeholder = 'Высота';
                        heightInput.min = '240';
                        heightInput.max = '2160';
                        heightInput.style.cssText = 'flex: 1; padding: 4px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px;';
                        
                        sizeRow.appendChild(widthInput);
                        sizeRow.appendChild(heightInput);
                        
                        // Строка с FPS и кнопкой
                        const controlRow = document.createElement('div');
                        controlRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px;';
                        
                        const fpsInput = document.createElement('input');
                        fpsInput.id = 'custom-fps';
                        fpsInput.type = 'number';
                        fpsInput.placeholder = 'FPS';
                        fpsInput.min = '1';
                        fpsInput.max = '60';
                        fpsInput.style.cssText = 'flex: 1; padding: 4px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 11px;';
                        
                        const applyButton = document.createElement('button');
                        applyButton.id = 'apply-custom';
                        applyButton.textContent = 'Установить';
                        applyButton.style.cssText = 'flex: 1; padding: 4px 12px; border-radius: 4px; background: #4CAF50; border: none; color: white; font-size: 11px; cursor: pointer; transition: background 0.2s;';
                        
                        controlRow.appendChild(fpsInput);
                        controlRow.appendChild(applyButton);
                        
                        customInner.appendChild(sizeRow);
                        customInner.appendChild(controlRow);
                        customSettings.appendChild(customInner);
                        
                        // Текущее качество
                        const currentQuality = document.createElement('div');
                        currentQuality.id = 'current-quality';
                        currentQuality.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); font-size: 10px; font-family: monospace;';
                        currentQuality.textContent = 'Текущее: -';
                        
                        qualityPanel.appendChild(title);
                        qualityPanel.appendChild(select);
                        qualityPanel.appendChild(customSettings);
                        qualityPanel.appendChild(currentQuality);
                        
                        container.appendChild(qualityPanel);
                        
                        console.log('[DEBUG] Quality panel created');
                        return true;
                    })();
                `);
            }
            
            // ШАГ 4: Добавляем функциональность - передаем showQualityControls как переменную
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    const showQualityControls = ${showQualityControls};
                    
                    const qualityToggle = document.getElementById('quality-toggle');
                    const qualityPanel = document.getElementById('quality-panel');
                    const qualityPreset = document.getElementById('quality-preset');
                    const customSettings = document.getElementById('custom-settings');
                    const applyCustom = document.getElementById('apply-custom');
                    const indicatorBar = document.getElementById('indicator-bar');
                    
                    // Только если есть элементы управления качеством
                    if (qualityToggle && qualityPanel) {
                        // Переключение панели
                        qualityToggle.onclick = function(e) {
                            e.stopPropagation();
                            qualityPanel.style.display = qualityPanel.style.display === 'none' ? 'block' : 'none';
                        };
                        
                        // Закрытие при клике вне
                        document.addEventListener('click', function(e) {
                            const container = document.getElementById('native-debug-indicator');
                            if (container && !container.contains(e.target)) {
                                if (qualityPanel) qualityPanel.style.display = 'none';
                            }
                        });
                        
                        // Выбор пресета
                        if (qualityPreset) {
                            qualityPreset.onchange = async function() {
                                const value = this.value;
                                if (value === 'CUSTOM') {
                                    if (customSettings) customSettings.style.display = 'block';
                                } else {
                                    if (customSettings) customSettings.style.display = 'none';
                                    if (window.ipcRenderer) {
                                        const result = await window.ipcRenderer.invoke('jitsi:change-video-quality', value);
                                        console.log('[Quality] Preset result:', result);
                                    }
                                }
                            };
                        }
                        
                        // Применение кастомных настроек
                        if (applyCustom) {
                            applyCustom.onclick = async function() {
                                const width = parseInt(document.getElementById('custom-width').value);
                                const height = parseInt(document.getElementById('custom-height').value);
                                const fps = parseInt(document.getElementById('custom-fps').value);
                                
                                if (width && height && fps && window.ipcRenderer) {
                                    const result = await window.ipcRenderer.invoke('jitsi:set-custom-quality', width, height, fps);
                                    console.log('[Quality] Custom result:', result);
                                }
                            };
                        }
                    }
                    
                    // Двойной клик для скрытия (работает всегда)
                    if (indicatorBar) {
                        indicatorBar.ondblclick = function() {
                            indicatorBar.style.opacity = '0.1';
                            if (qualityPanel) qualityPanel.style.display = 'none';
                            setTimeout(() => {
                                indicatorBar.style.opacity = '1';
                            }, 3000);
                        };
                    }
                    
                    // Функция обновления индикаторов
                    window.updateDebugIndicator = function(data) {
                        const pluginDot = document.getElementById('plugin-dot');
                        const audioDot = document.getElementById('audio-dot');
                        
                        if (pluginDot && data.hasAddon !== undefined) {
                            pluginDot.style.background = data.hasAddon ? '#4CAF50' : '#f44336';
                        }
                        
                        if (audioDot) {
                            const isAudioActive = data.nativeCaptureActive && 
                                                data.audioFrameCount > 0 && 
                                                data.isStreamActive;
                            audioDot.style.background = isAudioActive ? '#4CAF50' : '#2196F3';
                            audioDot.style.animation = isAudioActive ? 'pulse 2s infinite' : 'none';
                        }
                    };
                    
                    console.log('[DEBUG] ✅ Debug indicator ready (quality controls:', showQualityControls, ')');
                    return true;
                })();
            `);
            
            log.info(`✅ Debug indicator injected successfully (quality controls: ${showQualityControls})`);
            
            // Отправляем начальные данные
            const debugInfo = await this.getDebugInfo();
            await this.state.window.webContents.executeJavaScript(`
                if (window.updateDebugIndicator) {
                    window.updateDebugIndicator(${JSON.stringify(debugInfo)});
                }
            `);
            
            // Запускаем мониторинг
            this.startDebugMonitoring();
            
        } catch (error: any) {
            log.error(`[JITSI-MANAGER] Injection error: ${error.message}`);
        }
    }
    
    private startDebugMonitoring(): void {
        if (!this.config.enableDebugUI || this.debugMonitoringInterval) return;
        
        log.info("[JITSI-MANAGER] Starting minimal debug monitoring...");
        
        const updateInterval = 2000; // Обновляем каждые 2 секунды (реже чем раньше)
        
        this.debugMonitoringInterval = setInterval(async () => {
            if (!this.state.window || this.state.window.isDestroyed()) {
                clearInterval(this.debugMonitoringInterval);
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
                
            } catch (error) {
                // Тихо игнорируем ошибки мониторинга
            }
        }, updateInterval);
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
    
    async changeVideoQuality(presetName: keyof typeof VIDEO_QUALITY_PRESETS): Promise<{ success: boolean; quality?: string; error?: string }> {
        log.info(`[JITSI-NATIVE-MANAGER] Changing video quality to: ${presetName}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No window available" };
        }
        
        try {
            const preset = this.videoQualityManager.setPreset(presetName);
            
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
            `);
            
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

    private async leaveConference(): Promise<boolean> {
        if (!this.state.window || this.state.window.isDestroyed()) {
            return false;
        }
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[JitsiManager] Attempting to leave conference...');
                    
                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => {
                            track.stop();
                            console.log('[JitsiManager] Stopped track:', track.kind);
                        });
                    }
                    
                    if (window.APP && window.APP.conference) {
                        if (window.APP.conference.hangup) {
                            window.APP.conference.hangup(true);
                            console.log('[JitsiManager] Called hangup()');
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            return true;
                        }
                        
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

    private async nukeClearAllStreams(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            await this.state.window.webContents.executeJavaScript(`
                (function() {
                    console.log('[NUKE] === SELECTIVE CLEANUP STARTING ===');
                    window.__interceptorFlag = false;

                    if (window.jitsiNativeMediaStream) {
                        window.jitsiNativeMediaStream.getTracks().forEach(track => {
                            if (track.readyState === 'live') {
                                track.stop();
                                console.log('[NUKE] Stopped native track:', track.id, track.kind);
                            }
                        });
                        window.jitsiNativeMediaStream = null;
                    }
                    
                    if (window.APP?.conference) {
                        const tracks = window.APP.conference.getLocalTracks?.() || [];
                        tracks.forEach(t => {
                            if (t.videoType === 'desktop' || t.type === 'desktop') {
                                if (t.dispose) t.dispose();
                                console.log('[NUKE] Disposed desktop track');
                            }
                        });
                    }
                    
                    console.log('[NUKE] === SELECTIVE CLEANUP COMPLETED ===');
                })();
            `);
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Selective clear error: ${error.message}`);
        }
    }

    private async forceReleaseAllMediaResources(): Promise<void> {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        try {
            const cdp = this.state.window.webContents.debugger;
            
            try {
                if (!cdp.isAttached()) {
                    await cdp.attach('1.3');
                }
                
                await cdp.sendCommand('Page.stopScreencast');
                await cdp.sendCommand('Browser.resetPermissions');
                
                await cdp.detach();
            } catch (cdpError) {
                log.warn(`[JITSI-NATIVE-MANAGER] CDP cleanup error: ${cdpError}`);
            }
            
            await this.state.window.webContents.executeJavaScript(`
                if (typeof gc !== 'undefined') {
                    gc();
                    gc();
                }
            `);
            
            const session = this.state.window.webContents.session;
            await session.clearCache();
            
            log.info("[JITSI-NATIVE-MANAGER] Forced release of all media resources");
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Error releasing media resources: ${error.message}`);
        }
    }

    private async cleanup(): Promise<void> {
        log.info("[JITSI-NATIVE-MANAGER] Starting cleanup...");
        
        try {
            await this.nukeClearAllStreams();
            await new Promise(resolve => setTimeout(resolve, 200));
            
            if (this.nativeCapture && this.nativeCapture.isCapturing) {
                await this.nativeCapture.stopCapture();
            }
            
            await this.forceReleaseAllMediaResources();
            
            this.nativeCapture.setFrameCallbacks(undefined, undefined);
            
            this.state.isStreamActive = false;
            this.state.streamId = null;
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            this.activeMediaStreams.clear();

            if (this.debugMonitoringInterval) {
                clearInterval(this.debugMonitoringInterval);
                this.debugMonitoringInterval = undefined;
            }
            
            log.info("[JITSI-NATIVE-MANAGER] Cleanup completed");
            
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Cleanup error: ${error.message}`);
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

export default JitsiNativeManager;