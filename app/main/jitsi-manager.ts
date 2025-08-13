// jitsi-manager.ts - Модуль для управления Jitsi окнами
import { BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import log from "electron-log";
import { NativeCaptureManager } from "./native-capture";

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

export class JitsiManager {
  private state: JitsiState = {
    window: null,
    isStreamActive: false,
    streamId: null
  };

  private nativeCapture: NativeCaptureManager;
  private bundlePath: string;
  private iconPath: string;

  constructor(nativeCapture: NativeCaptureManager, bundlePath: string, iconPath: string) {
    this.nativeCapture = nativeCapture;
    this.bundlePath = bundlePath;
    this.iconPath = iconPath;
    this.registerHandlers();
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
  }

  async createWindow(options: JitsiOptions): Promise<{ success: boolean; error?: string }> {
    try {
        // Закрываем предыдущее окно если есть
        await this.closeWindow();

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

        // Обработчик закрытия
        this.state.window.on('closed', () => {
        this.cleanup();
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
                
                // === ОТЛАДОЧНЫЙ ИНДИКАТОР ===
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
                function updateDebugIndicator() {
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
                }
                
                setInterval(updateDebugIndicator, 500);
                
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

        // Добавляем кнопку native stream
        await this.state.window.webContents.executeJavaScript(`
            ${this.getNativeStreamButtonCode()}
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

  // Вспомогательный метод для показа системного диалога
  private async showSystemPicker(): Promise<{ success: boolean; sourceId?: string }> {
    try {
        // Используем Electron's desktopCapturer как fallback
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 300, height: 200 }
        });
        
        if (sources.length === 0) {
            return { success: false };
        }
        
        // Для простоты берем первый экран
        const screen = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        
        log.info(`System picker: selected ${screen.id}`);
        return { success: true, sourceId: screen.id };
        
    } catch (error: any) {
        log.error(`System picker error: ${error.message}`);
        return { success: false };
    }
  }



    // ===== ГЛАВНАЯ ФУНКЦИЯ =====
    async injectNativeStream(): Promise<{ success: boolean; error?: string; streamId?: string }> {
        log.info("[STREAM-ELECTRON] === START injectNativeStream ===");
        
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
            // Устанавливаем минимальное качество видео (не используется)
            await this.nativeCapture.useQualityPreset('ULTRALOW');
            log.info("[STREAM-ELECTRON] Video quality set to ULTRALOW (not used)");
            
            // Запускаем захват
            const result = await this.nativeCapture.startCapture(sourceId);
            
            if (result.success) {
                log.info("[STREAM-ELECTRON] <<< startNativeAudioCapture SUCCESS");
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
        
        try {
            const result = await this.state.window.webContents.executeJavaScript(`
                (async function() {
                    console.log('[STREAM-ELECTRON] Creating hybrid stream...');
                    
                    try {
                        // 1. Получаем VIDEO от Electron
                        const videoStream = await navigator.mediaDevices.getUserMedia({
                            audio: false,
                            video: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: '${electronSourceId}',
                                    minWidth: 1280,
                                    maxWidth: 1920,
                                    minHeight: 720,
                                    maxHeight: 1080,
                                    minFrameRate: 15,
                                    maxFrameRate: 30
                                }
                            }
                        });
                        
                        const videoTrack = videoStream.getVideoTracks()[0];
                        const settings = videoTrack.getSettings();
                        console.log('[STREAM-ELECTRON] Video:', settings.width + 'x' + settings.height);
                        
                        // 2. Создаем AUDIO контекст для Native
                        const audioContext = new AudioContext({ 
                            sampleRate: 48000, 
                            latencyHint: 'interactive' 
                        });
                        
                        const scriptProcessor = audioContext.createScriptProcessor(2048, 0, 2);
                        
                        // RingBuffer
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
                        
                        // 3. СОЗДАЕМ ГИБРИДНЫЙ ПОТОК
                        const hybridStream = new MediaStream();
                        
                        // Добавляем видео
                        hybridStream.addTrack(videoTrack);
                        console.log('[STREAM-ELECTRON] Added video track');
                        
                        // Добавляем аудио
                        if (destination.stream.getAudioTracks().length > 0) {
                            hybridStream.addTrack(destination.stream.getAudioTracks()[0]);
                            console.log('[STREAM-ELECTRON] Added audio track');
                        }
                        
                        // 4. Сохраняем все в window
                        window.jitsiNativeMediaStream = hybridStream;
                        window.leftRingBuffer = leftRingBuffer;
                        window.rightRingBuffer = rightRingBuffer;
                        window.nativeAudioContext = audioContext;
                        window.isNativeActive = true;
                        window.isHybridMode = true;
                        window.audioCounter = 0;
                        
                        // Resume audio context
                        if (audioContext.state === 'suspended') {
                            await audioContext.resume();
                        }
                        
                        console.log('[STREAM-ELECTRON] Hybrid stream ready!');
                        
                        return {
                            success: true,
                            streamId: hybridStream.id,
                            videoQuality: settings.width + 'x' + settings.height
                        };
                        
                    } catch (error) {
                        console.error('[STREAM-ELECTRON] Error:', error);
                        return { success: false, error: error.message };
                    }
                })();
            `);
            
            if (result.success) {
                log.info(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi SUCCESS`);
            } else {
                log.error(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi FAILED: ${result.error}`);
            }
            
            return result;
            
        } catch (error: any) {
            log.error(`[STREAM-ELECTRON] <<< createHybridStreamInJitsi ERROR: ${error.message}`);
            return { success: false, error: error.message };
        }
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
        if (!audioData || !audioData.data || audioData.source !== 'system') return;
        
        this.state.audioFrameCount++;
        
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

  private cleanup(): void {
    log.info("Cleaning up Jitsi window...");
    
    this.state.isStreamActive = false;
    this.state.streamId = null;
    this.state.window = null;

    // Останавливаем native capture если активен
    if (this.nativeCapture.isCapturing) {
      this.nativeCapture.stopCapture();
    }
  }

  async closeWindow(): Promise<void> {
    if (this.state.window && !this.state.window.isDestroyed()) {
      this.state.window.close();
      this.state.window = null;
    }
    this.cleanup();
  }

  private createTestPattern(width: number, height: number, frameNum: number): string {
    // Этот метод больше не используется, паттерн создается прямо в Jitsi
    return "";
  }
}

export default JitsiManager;