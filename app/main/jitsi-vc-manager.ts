// jitsi-native-manager.ts - Управление Jitsi-окном с поддержкой нативного захвата ИЛИ виртуального аудиокабеля
import { BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import log from "electron-log";
import { NativeCaptureManager } from "./native-capture";
import { JitsiScreenShareMonitor } from "./jitsi-screen-share-monitor";
import { 
    VideoQualityManager, 
    VIDEO_QUALITY_PRESETS
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
    private useVirtualCableMode: boolean = false; // 🆕 Флаг режима Virtual Cable

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
    }

    // 🆕 Метод для включения режима Virtual Cable
    enableVirtualCableMode(enable: boolean): void {
        this.useVirtualCableMode = enable;
        log.info(`[JITSI-NATIVE-MANAGER] Virtual Cable mode: ${enable ? 'ENABLED' : 'DISABLED'}`);
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
                    if (window.jitsiHandlersInjected) return;
                    window.jitsiHandlersInjected = true;
                    // ... (оставляем оригинальный код инъекции без изменений)
                    // Полный код из оригинального файла остаётся здесь
                    // (для краткости опущен — он идентичен вашему текущему)
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
                // 🆕 Режим Virtual Cable: захват только видео + аудио с виртуального устройства
                const result = await this.createVirtualCableHybridStream(electronSourceId);
                if (result.success) {
                    this.state.isStreamActive = true;
                    this.state.streamId = result.streamId;
                    log.info("[VC-MODE] Hybrid stream via Virtual Cable created");
                }
                return result;
            } else {
                // Стандартный нативный режим
                const audioResult = await this.startNativeAudioCapture(electronSourceId);
                if (!audioResult.success) return { success: false, error: audioResult.error };

                const streamResult = await this.createHybridStreamInJitsi(electronSourceId);
                if (!streamResult?.success) {
                    await this.nativeCapture.stopCapture();
                    return { success: false, error: streamResult?.error || "Stream creation failed" };
                }

                this.setupAudioCallbacks();
                this.state.isStreamActive = true;
                this.state.streamId = streamResult.streamId;
                return streamResult;
            }
        } catch (error: any) {
            log.error(`[JITSI-NATIVE-MANAGER] Error: ${error.message}`);
            if (!this.useVirtualCableMode) {
                await this.nativeCapture.stopCapture();
            }
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

                        // 1. Захват ВИДЕО через Electron
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

                        // 2. Захват АУДИО с виртуального кабеля
                        let audioStream;
                        try {
                            const devices = await navigator.mediaDevices.enumerateDevices();
                            const vcDevice = devices.find(d => 
                                d.kind === 'audioinput' && 
                                (d.label.includes('CABLE Input') || 
                                 d.label.includes('VoiceMeeter Input') ||
                                 d.label.includes('VB-Audio'))
                            );
                            if (vcDevice) {
                                audioStream = await navigator.mediaDevices.getUserMedia({
                                    audio: { deviceId: { exact: vcDevice.deviceId } },
                                    video: false
                                });
                            } else {
                                throw new Error('Virtual cable device not found');
                            }
                        } catch (e) {
                            console.error('[VC-MODE] Audio capture failed:', e);
                            throw new Error('Failed to capture audio from virtual cable');
                        }

                        // 3. Объединение
                        const hybridStream = new MediaStream();
                        hybridStream.addTrack(videoStream.getVideoTracks()[0]);
                        hybridStream.addTrack(audioStream.getAudioTracks()[0]);

                        window.jitsiNativeMediaStream = hybridStream;
                        window.isNativeActive = true;
                        window.isScreenShareActive = true;
                        window.isHybridMode = true;
                        window.isVirtualCableMode = true;

                        console.log('[VC-MODE] ✅ Hybrid stream created via Virtual Cable');
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

    // ... остальные методы (startNativeAudioCapture, convertElectronToNativeId, createHybridStreamInJitsi, setupAudioCallbacks и т.д.)
    // остаются без изменений — как в вашем исходном файле

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