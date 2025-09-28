// jitsi-native-manager.ts - Упрощенный модуль для управления Jitsi окнами (только нативный режим)
import { BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import log from "electron-log";
import { NativeCaptureManager } from "./native-capture";
import { JitsiScreenShareMonitor } from "./jitsi-screen-share-monitor";
import { getSourcePickerCode, injectSourcePickerFunction, logSourcePickerEvent } from "./electron-custom-source-picker";
import { 
    VideoQualityManager, 
    VideoQualityPreset, 
    VIDEO_QUALITY_PRESETS,
    getApplyQualityPresetCode,
    getApplyCustomQualityCode
} from "./video-quality-manager";

import {
    AudioProcessor,
    AudioLevels,
    getRingBufferCode,
    getParticipantAudioMixerCode,
    getSendAudioToJitsiCode
} from "./audio-processor";
import { JitsiUIManager } from "./jitsi-ui-manager";
import { JitsiWindowUtils } from "./jitsi-window-utils";
import { JitsiOptions, JitsiState, JitsiManagerConfig } from './jitsi-types';
import { JitsiURLBuilder } from './jitsi-url-builder';


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
    private audioProcessor: AudioProcessor;
    private uiManager: JitsiUIManager;
    private jitsiUtils: JitsiWindowUtils;
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

        this.audioProcessor = new AudioProcessor();
        this.uiManager = new JitsiUIManager();
        this.jitsiUtils = new JitsiWindowUtils();

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

            await this.uiManager.injectLoadingScreen(this.state.window);
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

            const conferenceUrl = JitsiURLBuilder.buildConferenceUrl(server, roomName, options);
            
            log.info(`Loading conference URL: ${conferenceUrl}`);

            this.state.window.webContents.on('did-finish-load', async () => {
                log.info("[JITSI-NATIVE-MANAGER] Page loaded, injecting handlers...");
                
                if (this.state.window) {
                    await this.uiManager.waitForJitsiReady(this.state.window);
                    await this.uiManager.hideLoadingScreen(this.state.window);
                    
                    setTimeout(async () => {
                        if (this.state.window) {
                            await this.uiManager.injectDebugOverlay(
                                this.state.window,
                                this.config,
                                this.nativeCapture && this.nativeCapture.isNativeAvailable(),
                                false, // useStandardJitsi - у вас его нет в коде, поэтому передаю false
                                false, // useNativeAudio - тоже не вижу в state, передаю false или добавьте this.state.useNativeAudio
                                () => this.getDebugInfo() // передаем как функцию
                            );
                            await this.startDebugMonitoring();
                        }
                    }, 500);
                }
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
            await this.uiManager.injectDebugOverlay(
                                this.state.window,
                                this.config,
                                this.nativeCapture && this.nativeCapture.isNativeAvailable(),
                                false, // useStandardJitsi - у вас его нет в коде, поэтому передаю false
                                false, // useNativeAudio - тоже не вижу в state, передаю false или добавьте this.state.useNativeAudio
                                () => this.getDebugInfo() // передаем как функцию
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
        const debugInfo = {
            hasWindow: !!this.state.window && !this.state.window.isDestroyed(),
            isStreamActive: this.state.isStreamActive,
            streamId: this.state.streamId,
            nativeCaptureActive: this.nativeCapture.isCapturing,
            videoFrameCount: this.state.videoFrameCount,
            audioFrameCount: this.state.audioFrameCount,
            lastSelectedSource: this.state.lastSelectedSourceId,
            currentQuality: this.videoQualityManager.getCurrentSettings().name,
            hasAddon: this.nativeCapture && this.nativeCapture.isNativeAvailable()
        };
        
        log.info("[JITSI-NATIVE-MANAGER] Debug info:", debugInfo);
        return debugInfo;
    }

    private getSimplifiedScreenShareInterceptorCode(): string {
        // Импортируем функцию выбора источника из отдельного модуля
        const sourcePickerCode = getSourcePickerCode();
        
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
                
                // Инжектируем функцию показа выбора источника из модуля
                ${sourcePickerCode}

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
                            
                            // Используем импортированную функцию showSourcePicker
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

    private async createHybridStreamInJitsi(electronSourceId: string): Promise<any> {
        log.info(`[STREAM-ELECTRON] >>> createHybridStreamInJitsi: ${electronSourceId}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            log.error("[STREAM-ELECTRON] No window");
            return { success: false, error: "No window" };
        }
        
        const qualitySettings = this.videoQualityManager.getCurrentSettings();
        
        // Получаем код классов из модулей
        const ringBufferCode = getRingBufferCode();
        const participantAudioMixerCode = getParticipantAudioMixerCode();
        
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

                        // ============ ИНЖЕКТИРУЕМ КЛАССЫ ИЗ МОДУЛЕЙ ============
                        ${ringBufferCode}
                        ${participantAudioMixerCode}
                        
                        // Создаем глобальный микшер для участников
                        window.participantAudioMixer = new ParticipantAudioMixer();
                        console.log('[HYBRID] Participant audio mixer created');
                        
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
                        
                        // 3. Создаем буферы для демонстрации с использованием класса из модуля
                        console.log('[HYBRID] Creating screen share ring buffers...');
                        
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
            const samples = this.audioProcessor.getSamplesForPlatform(audioData);
            const channels = audioData.channels || 2;
            
            // Используем AudioProcessor для декодирования
            const { leftChannel, rightChannel } = this.audioProcessor.decodeAudio(
                arrayBuffer, 
                samples, 
                channels
            );
            
            // Анализируем уровни
            const levels = this.audioProcessor.analyzeAudioLevels(leftChannel, rightChannel);
            
            // Нормализуем
            const { processedLeft, processedRight } = this.audioProcessor.normalizeAudio(
                leftChannel, 
                rightChannel, 
                levels
            );
            
            // Отправляем в Jitsi
            this.sendAudioToJitsi(processedLeft, processedRight, samples);
        } catch (error: any) {
            log.error(`[AUDIO] processNativeAudio ERROR: ${error.message}`);
        }
    }

    private sendAudioToJitsi(leftData: Float32Array, rightData: Float32Array, samples: number): void {
        if (!this.state.window || this.state.window.isDestroyed()) return;
        
        // Используем функцию из audio-processor модуля
        const jsCode = getSendAudioToJitsiCode(leftData, rightData, samples);
        
        this.state.window.webContents.executeJavaScript(jsCode).catch((err) => {
            log.error(`[SEND-TO-JITSI] Execute error: ${err.message}`);
        });
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
    
    async changeVideoQuality(presetName: keyof typeof VIDEO_QUALITY_PRESETS): Promise<{ success: boolean; quality?: string; error?: string }> {
        log.info(`[JITSI-NATIVE-MANAGER] Changing video quality to: ${presetName}`);
        
        if (!this.state.window || this.state.window.isDestroyed()) {
            return { success: false, error: "No window available" };
        }
        
        try {
            const preset = this.videoQualityManager.setPreset(presetName);
            
            // Используем функцию из video-quality-manager
            const result = await this.state.window.webContents.executeJavaScript(
                getApplyQualityPresetCode(preset, presetName)
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

                if (this.debugMonitoringInterval) {
                    clearInterval(this.debugMonitoringInterval);
                    this.debugMonitoringInterval = undefined;
                }
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