import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import { WalkieTalkieStatus } from "../../common/typed-ipc.js";

// ====================================
// РАСШИРЕННОЕ ЛОГИРОВАНИЕ ДЛЯ ОТЛАДКИ
// ====================================
ipcRenderer.send("preload-log", "====================================");
ipcRenderer.send("preload-log", "PRELOAD STARTED");
ipcRenderer.send("preload-log", `Platform: ${process.platform}`);
ipcRenderer.send("preload-log", `URL: ${window.location.href}`);
ipcRenderer.send("preload-log", `Process type: ${process.type}`);
ipcRenderer.send("preload-log", `Node version: ${process.versions.node}`);
ipcRenderer.send("preload-log", `Electron version: ${process.versions.electron}`);
ipcRenderer.send("preload-log", "====================================");

// Обработчики для отладки native захвата
electron_bridge.on_event("native-capture-status", (status: any) => {
    ipcRenderer.send("preload-log", `🔊 [NATIVE-CAPTURE] Status: ${JSON.stringify(status)}`);
});

electron_bridge.on_event("native-audio-frame", (data: any) => {
    ipcRenderer.send("preload-log", `🔊 [NATIVE-AUDIO] Frame received: size=${data?.byteLength}, source=${data?.source}`);
});

electron_bridge.on_event("screen-share-started", (data: any) => {
    ipcRenderer.send("preload-log", `🖥️ [SCREEN-SHARE] Started: ${JSON.stringify(data)}`);
});

electron_bridge.on_event("screen-share-stopped", () => {
    ipcRenderer.send("preload-log", `🖥️ [SCREEN-SHARE] Stopped`);
});

// === ОСНОВНОЕ: Обработчик запроса источников ===
electron_bridge.on_event("requestDesktopSources", async () => {
    ipcRenderer.send("preload-log", "🎯 [PRELOAD_DEBUG] requestDesktopSources event received!");
    
    try {
        // Запрашиваем источники через IPC
        const sources = await ipcRenderer.invoke('get-desktop-sources');
        ipcRenderer.send("preload-log", `🎯 [PRELOAD_DEBUG] Got ${sources.length} sources from main process`);
        
        if (sources && sources.length > 0) {
            // Логируем источники
            sources.forEach((source: any, i: number) => {
                ipcRenderer.send("preload-log", `🎯 Source ${i}: ${source.name} (${source.id})`);
            });
            
            // Подготавливаем объект ответа
            const responseToSend = {
                sources: sources,
                error: null
            };

            // Отправляем ответ через electron_bridge
            electron_bridge.send_event("desktop-sources-response", responseToSend);
            ipcRenderer.send("preload-log", "✅ Preload: Sources sent via electron_bridge");
            
        } else {
            ipcRenderer.send("preload-log", "⚠️ Preload: No sources received!");
            const errorResponse = {
                sources: [],
                error: "No sources available"
            };
            electron_bridge.send_event("desktop-sources-response", errorResponse);
        }
        
    } catch (error: any) {
        ipcRenderer.send("preload-log", `❌ Preload: Error getting sources: ${error.message}`);
        const errorResponse = {
            sources: [],
            error: error.message
        };
        electron_bridge.send_event("desktop-sources-response", errorResponse);
    }
});

// === WALKIE-TALKIE ===
ipcRenderer.on("toggle-walkie-talkie", (event, isMuted: boolean) => {
    ipcRenderer.send("preload-log", `Preload: toggle-walkie-talkie: isMuted=${isMuted}`);
    bridgeEvents.emit("toggle-walkie-talkie", isMuted);
});

// === EXPOSE ELECTRON_BRIDGE ===
contextBridge.exposeInMainWorld("electron_bridge", {
    ...electron_bridge,
    setMicHotkey: (enabled: boolean, hotkey: string) => {
        ipcRenderer.send("preload-log", `Preload: Установка горячей клавиши: ${hotkey}`);
        ipcRenderer.send("walkie-talkie-status", { enabled: enabled, key: hotkey });
    },
    onMicStateChanged: (callback: (data: boolean) => void) => {
        bridgeEvents.on("toggle-walkie-talkie", callback);
    }
});

// === NATIVE AUDIO DEBUG API ===
contextBridge.exposeInMainWorld('nativeAudioDebug', {
    checkAudioCapture: async () => {
        ipcRenderer.send("preload-log", "🔊 [DEBUG] Checking audio capture status...");
        
        try {
            // Проверяем статус native модуля
            const moduleStatus = await ipcRenderer.invoke('test-native-audio');
            ipcRenderer.send("preload-log", `🔊 [DEBUG] Module status: ${JSON.stringify(moduleStatus)}`);
            
            // Проверяем статус захвата
            const captureStatus = await ipcRenderer.invoke('get-capture-status');
            ipcRenderer.send("preload-log", `🔊 [DEBUG] Capture status: ${JSON.stringify(captureStatus)}`);
            
            return {
                module: moduleStatus,
                capture: captureStatus
            };
        } catch (error: any) {
            ipcRenderer.send("preload-log", `❌ [DEBUG] Error: ${error.message}`);
            return { error: error.message };
        }
    },
    
    testAudioStream: async () => {
        ipcRenderer.send("preload-log", "🔊 [DEBUG] Testing audio stream...");
        
        try {
            // Запускаем тестовый захват
            const startResult = await ipcRenderer.invoke('start-native-capture', 'screen:1:0');
            ipcRenderer.send("preload-log", `🔊 [DEBUG] Start result: ${JSON.stringify(startResult)}`);
            
            // Ждем 3 секунды и проверяем
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const status = await ipcRenderer.invoke('get-capture-status');
            ipcRenderer.send("preload-log", `🔊 [DEBUG] After 3s: ${JSON.stringify(status)}`);
            
            // Останавливаем
            const stopResult = await ipcRenderer.invoke('stop-native-capture');
            ipcRenderer.send("preload-log", `🔊 [DEBUG] Stop result: ${JSON.stringify(stopResult)}`);
            
            return { 
                started: startResult,
                status: status,
                stopped: stopResult
            };
        } catch (error: any) {
            ipcRenderer.send("preload-log", `❌ [DEBUG] Test error: ${error.message}`);
            return { error: error.message };
        }
    }
});

// === SCREEN CAPTURE API С ЛОГИРОВАНИЕМ ===
contextBridge.exposeInMainWorld('screenCapture', {
    startCapture: async (options: {
        sourceId: string;
        width: number;
        height: number;
        frameRate: number;
    }) => {
        ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Starting with options: ${JSON.stringify(options)}`);
        
        try {
            const response = await ipcRenderer.invoke("screen-capture-start", options);
            ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Start response: ${JSON.stringify(response)}`);
            
            if (response.success) {
                ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Audio enabled: ${response.hasAudio || false}`);
                return response.result;
            } else {
                throw new Error(response.error);
            }
        } catch (error: any) {
            ipcRenderer.send("preload-log", `❌ [SCREEN-CAPTURE] Start error: ${error.message}`);
            throw error;
        }
    },
    
    stopCapture: async () => {
        ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Stopping capture...`);
        
        try {
            const response = await ipcRenderer.invoke("screen-capture-stop");
            ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Stop response: ${JSON.stringify(response)}`);
            
            if (!response.success) {
                throw new Error(response.error);
            }
        } catch (error: any) {
            ipcRenderer.send("preload-log", `❌ [SCREEN-CAPTURE] Stop error: ${error.message}`);
            throw error;
        }
    },
    
    testMethod: async () => {
        ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Testing method...`);
        
        try {
            const response = await ipcRenderer.invoke("screen-capture-test");
            ipcRenderer.send("preload-log", `📹 [SCREEN-CAPTURE] Test response: ${JSON.stringify(response)}`);
            
            if (response.success) {
                return response.result;
            } else {
                throw new Error(response.error);
            }
        } catch (error: any) {
            ipcRenderer.send("preload-log", `❌ [SCREEN-CAPTURE] Test error: ${error.message}`);
            return "Error calling test method";
        }
    }
});

// === EXPOSE IPC RENDERER ДЛЯ ZULIP ===
contextBridge.exposeInMainWorld("ipcRenderer", {
    invoke: async (channel: any, ...args: unknown[]) => {
        ipcRenderer.send("preload-log", `Zulip: ipcRenderer.invoke ${channel}`);
        try {
            const result = await ipcRenderer.invoke(channel, ...args);
            return result;
        } catch (error) {
            ipcRenderer.send("preload-log", `Zulip: Ошибка ${channel}: ${error}`);
            throw error;
        }
    },
    on: (channel: any, listener: (event: any, ...args: any[]) => void) => {
        ipcRenderer.on(channel, listener);
    }
});

// === ОБРАБОТЧИКИ СОБЫТИЙ ===

ipcRenderer.on("logout", () => {
    bridgeEvents.emit("logout");
});

ipcRenderer.on("show-keyboard-shortcuts", () => {
    bridgeEvents.emit("show-keyboard-shortcuts");
});

ipcRenderer.on("show-notification-settings", () => {
    bridgeEvents.emit("show-notification-settings");
});

// Прямые обработчики
ipcRenderer.on("trigger-open-desktop-picker", () => {
    ipcRenderer.send("preload-log", "✅ Preload: trigger-open-desktop-picker");
    electron_bridge.send_event("open-desktop-picker");
});

ipcRenderer.on("requestDesktopSources", () => {
    ipcRenderer.send("preload-log", "✅ Preload: requestDesktopSources (direct)");
    electron_bridge.send_event("requestDesktopSources");
});

// Forward message handler
ipcRenderer.on("forward-message", (event, channel) => {
    ipcRenderer.send("preload-log", `✅ Preload: forward-message: ${channel}`);
    
    if (channel === "trigger-open-desktop-picker") {
        electron_bridge.send_event("open-desktop-picker");
    }
    if (channel === "request-desktop-sources") {
        electron_bridge.send_event("requestDesktopSources");
    }
    if (channel === "test-screen-capture-in-webview") {
        ipcRenderer.send("preload-log", "🧪 Testing screen capture in webview...");
        if (window.screenCapture) {
            window.screenCapture.testMethod().then(result => {
                ipcRenderer.send("preload-log", `✅ Test result: ${result}`);
            });
        }
    }
});

// Проверка аудио в Jitsi
ipcRenderer.on("check-jitsi-audio", async () => {
    ipcRenderer.send("preload-log", "🔊 [JITSI] Checking audio in Jitsi context...");
    
    // Проверяем есть ли активный stream
    if (window.jitsiNativeMediaStream) {
        const stream = window.jitsiNativeMediaStream;
        const audioTracks = stream.getAudioTracks();
        
        ipcRenderer.send("preload-log", `🔊 [JITSI] Stream found: ${stream.id}`);
        ipcRenderer.send("preload-log", `🔊 [JITSI] Audio tracks: ${audioTracks.length}`);
        
        audioTracks.forEach((track, i) => {
            ipcRenderer.send("preload-log", `🔊 [JITSI] Track ${i}: ${track.label}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
        });
    } else {
        ipcRenderer.send("preload-log", "❌ [JITSI] No jitsiNativeMediaStream found");
    }
});

// === МОНИТОРИНГ АУДИО ===
let audioCheckInterval: NodeJS.Timer | null = null;

electron_bridge.on_event("start-audio-monitoring", () => {
    ipcRenderer.send("preload-log", "🔊 [MONITOR] Starting audio monitoring...");
    
    if (audioCheckInterval) clearInterval(audioCheckInterval);
    
    let frameCount = 0;
    audioCheckInterval = setInterval(async () => {
        frameCount++;
        
        if (frameCount % 10 === 0) { // Каждые 10 секунд
            const status = await ipcRenderer.invoke('get-capture-status');
            ipcRenderer.send("preload-log", `🔊 [MONITOR] Status at ${frameCount}s: audioFrames=${status.audioFrames}, videoFrames=${status.videoFrames}`);
        }
    }, 1000);
});

electron_bridge.on_event("stop-audio-monitoring", () => {
    ipcRenderer.send("preload-log", "🔊 [MONITOR] Stopping audio monitoring");
    if (audioCheckInterval) {
        clearInterval(audioCheckInterval);
        audioCheckInterval = null;
    }
});

// === ОБРАБОТЧИКИ ДЛЯ DESKTOP SOURCES ===
electron_bridge.on_event('desktop-sources-response', (response) => {
    console.log('🔍 [PRELOAD] Sources response received:');
    console.log('  - Source type:', response.sourceType);
    console.log('  - Is native:', response.isNative);
    console.log('  - Sources count:', response.sources ? response.sources.length : 0);
    
    if (response.sources && response.sources.length > 0) {
        const first = response.sources[0];
        console.log('  - First source:', {
            id: first.id,
            name: first.name,
            isNative: first.isNative,
            hasNativePrefix: first.id.startsWith('native:'),
            hasElectronPrefix: first.id.startsWith('electron:')
        });
    }
});

// === NATIVE STREAM HANDLING ===
electron_bridge.on_event("shareNativeStream", async (streamData: any) => {
    ipcRenderer.send("preload-log", "🎯 Preload: shareNativeStream event received");
    
    // Пересылаем данные потока в webview/iframe с Jitsi
    electron_bridge.send_event("jitsi-share-external-stream", streamData);
    ipcRenderer.send("preload-log", "✅ Preload: Stream data sent to Jitsi");
});

// === EXPOSE NATIVE STREAM API ===
contextBridge.exposeInMainWorld('nativeStream', {
    createTestStream: async () => {
        ipcRenderer.send("preload-log", "🎯 Creating test MediaStream");
        
        try {
            // Создаем тестовый canvas для генерации видеопотока
            const canvas = document.createElement('canvas');
            canvas.width = 1920;
            canvas.height = 1080;
            const ctx = canvas.getContext('2d');
            
            if (!ctx) throw new Error('Failed to get canvas context');
            
            // Анимированный тестовый контент
            let frame = 0;
            const animate = () => {
                frame++;
                
                // Градиентный фон
                const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 600);
                gradient.addColorStop(0, `hsl(${frame % 360}, 70%, 50%)`);
                gradient.addColorStop(1, `hsl(${(frame + 180) % 360}, 60%, 30%)`);
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                // Текст
                ctx.fillStyle = 'white';
                ctx.font = 'bold 120px Arial';
                ctx.textAlign = 'center';
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 20;
                ctx.fillText('🎯 NATIVE STREAM', 960, 500);
                
                ctx.font = 'bold 60px Arial';
                ctx.fillText('connect-rm-video.ru', 960, 600);
                
                ctx.font = 'bold 40px Arial';
                ctx.fillText(`Frame: ${frame} | ${new Date().toLocaleTimeString()}`, 960, 700);
                
                requestAnimationFrame(animate);
            };
            animate();
            
            // Создаем MediaStream из canvas
            const stream = canvas.captureStream(30);
            
            // Добавляем аудио (тишина)
            const audioContext = new AudioContext();
            const oscillator = audioContext.createOscillator();
            oscillator.frequency.value = 0; // Тишина
            const destination = audioContext.createMediaStreamDestination();
            oscillator.connect(destination);
            oscillator.start();
            
            // Добавляем аудиотрек к потоку
            stream.addTrack(destination.stream.getAudioTracks()[0]);
            
            ipcRenderer.send("preload-log", `✅ Test stream created with ${stream.getTracks().length} tracks`);
            
            return {
                success: true,
                stream: stream,
                streamId: stream.id
            };
        } catch (error: any) {
            ipcRenderer.send("preload-log", `❌ Failed to create test stream: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    },
    
    shareStreamWithJitsi: async (stream: MediaStream) => {
        ipcRenderer.send("preload-log", "🎯 Sharing stream with Jitsi");
        
        // Отправляем событие для передачи потока в Jitsi
        electron_bridge.send_event("jitsi-share-external-stream", {
            streamId: stream.id,
            videoTracks: stream.getVideoTracks().length,
            audioTracks: stream.getAudioTracks().length,
            stream: stream
        });
        
        return { success: true };
    }
});

// === CREATE NATIVE STREAM FOR JITSI ===
ipcRenderer.on("create-native-stream-for-jitsi", async () => {
    ipcRenderer.send("preload-log", "🎯 [NATIVE-STREAM] Received create-native-stream-for-jitsi");
    ipcRenderer.send("preload-log", `🎯 [NATIVE-STREAM] Platform: ${process.platform}`);
    
    try {
        // Проверяем какой модуль используется
        const moduleInfo = await ipcRenderer.invoke('test-native-audio');
        ipcRenderer.send("preload-log", `🎯 [NATIVE-STREAM] Module info: ${JSON.stringify(moduleInfo)}`);
        
        // Если это Windows и используется mock
        if (process.platform === 'win32' && moduleInfo.isMock) {
            ipcRenderer.send("preload-log", "⚠️ [NATIVE-STREAM] WARNING: Using MOCK module on Windows!");
            ipcRenderer.send("preload-log", "⚠️ [NATIVE-STREAM] No real audio capture available!");
        }
        
        // Создаем MediaStream в контексте webview
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
            throw new Error('Failed to get canvas context');
        }
        
        let frame = 0;
        let animationActive = true;
        
        function animate() {
            if (!animationActive) return;
            
            frame++;
            
            // Градиентный фон
            const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 600);
            gradient.addColorStop(0, `hsl(${frame % 360}, 70%, 50%)`);
            gradient.addColorStop(1, `hsl(${(frame + 180) % 360}, 60%, 30%)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Текст
            ctx.fillStyle = 'white';
            ctx.font = 'bold 120px Arial';
            ctx.textAlign = 'center';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 20;
            ctx.fillText('🎯 ELECTRON → JITSI', 960, 400);
            
            ctx.font = 'bold 80px Arial';
            ctx.fillText('NATIVE STREAM', 960, 500);
            
            ctx.font = 'bold 50px Arial';
            ctx.fillText('connect-rm-video.ru', 960, 600);
            
            ctx.font = 'bold 40px Arial';
            ctx.fillText(`Frame: ${frame}`, 960, 700);
            
            ctx.font = 'bold 35px Arial';
            ctx.fillText(new Date().toLocaleTimeString(), 960, 770);
            
            requestAnimationFrame(animate);
        }
        animate();
        
        const stream = canvas.captureStream(30);
        
        ipcRenderer.send("preload-log", `✅ Stream created: ${stream.id}, tracks: ${stream.getTracks().length}`);
        
        // Сохраняем stream глобально
        window.nativeTestStream = stream;
        
        // Триггерим событие для Zulip/Jitsi
        if (window.electron_bridge) {
            electron_bridge.send_event("use-native-stream-in-jitsi", {
                streamId: stream.id,
                available: true
            });
        }
        
        // Также пробуем напрямую если кнопка есть
        setTimeout(() => {
            const nativeStreamBtn = document.querySelector('button[onclick*="shareNativeStream"]');
            if (nativeStreamBtn) {
                ipcRenderer.send("preload-log", "🎯 Found native stream button, clicking...");
                nativeStreamBtn.click();
            }
        }, 1000);
        
        // Останавливаем через 60 секунд
        setTimeout(() => {
            animationActive = false;
            stream.getTracks().forEach(track => track.stop());
            window.nativeTestStream = null;
            ipcRenderer.send("preload-log", "⏹️ Stream stopped after timeout");
        }, 60000);
        
    } catch (error: any) {
        ipcRenderer.send("preload-log", `❌ [NATIVE-STREAM] Error: ${error.message}`);
    }
});

// === CREATE AND SHARE NATIVE STREAM ===
electron_bridge.on_event("create-and-share-native-stream", async () => {
    ipcRenderer.send("preload-log", "🎯 Preload: create-and-share-native-stream received");
    
    try {
        // Создаем MediaStream прямо в контексте preload/webview
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) throw new Error('Failed to get canvas context');
        
        // Анимированный контент
        let frame = 0;
        let animationId = null;
        
        const animate = () => {
            frame++;
            
            // Градиентный фон
            const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 600);
            gradient.addColorStop(0, `hsl(${frame % 360}, 70%, 50%)`);
            gradient.addColorStop(1, `hsl(${(frame + 180) % 360}, 60%, 30%)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Текст
            ctx.fillStyle = 'white';
            ctx.font = 'bold 120px Arial';
            ctx.textAlign = 'center';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 20;
            ctx.fillText('🎯 ELECTRON NATIVE', 960, 450);
            
            ctx.font = 'bold 60px Arial';
            ctx.fillText('MediaStream Active', 960, 550);
            
            ctx.font = 'bold 40px Arial';
            ctx.fillText(`Frame: ${frame} | ${new Date().toLocaleTimeString()}`, 960, 650);
            
            animationId = requestAnimationFrame(animate);
        };
        animate();
        
        const stream = canvas.captureStream(30);
        
        ipcRenderer.send("preload-log", `✅ Preload: Stream created with ${stream.getTracks().length} tracks`);
        
        // Сохраняем stream глобально для доступа из Zulip
        window.electronNativeStream = stream;
        
        // Отправляем событие в Zulip для использования потока
        electron_bridge.send_event("native-stream-ready", {
            streamId: stream.id,
            hasStream: true
        });
        
        // Останавливаем анимацию через 30 секунд
        setTimeout(() => {
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
        }, 30000);
        
        return { success: true, streamId: stream.id };
        
    } catch (error) {
        ipcRenderer.send("preload-log", `❌ Preload: Error creating stream: ${error.message}`);
        electron_bridge.send_event("native-stream-error", { error: error.message });
        return { success: false, error: error.message };
    }
});

// === FORWARD MESSAGE HANDLERS ===
['create-native-stream-for-jitsi', 'forward-message'].forEach(channel => {
    ipcRenderer.on(channel, (event, ...args) => {
        ipcRenderer.send("preload-log", `🎯 Preload: Received ${channel}, args: ${JSON.stringify(args)}`);
        
        // Если это forward-message с нужной командой
        if (channel === 'forward-message' && args[0] === 'create-native-stream-for-jitsi') {
            createNativeStreamForJitsi();
        }
        
        // Если это прямая команда
        if (channel === 'create-native-stream-for-jitsi') {
            createNativeStreamForJitsi();
        }
    });
});

function createNativeStreamForJitsi() {
    ipcRenderer.send("preload-log", "🎯 Creating native stream for Jitsi...");
    
    try {
        // Проверяем контекст
        ipcRenderer.send("preload-log", `Context check:
            - location: ${window.location.href}
            - has electron_bridge: ${!!window.electron_bridge}
            - has api (Jitsi): ${!!window.api}
        `);
        
        // Создаем поток
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        
        let frame = 0;
        function animate() {
            frame++;
            const gradient = ctx.createRadialGradient(960, 540, 0, 960, 540, 600);
            gradient.addColorStop(0, `hsl(${frame % 360}, 70%, 50%)`);
            gradient.addColorStop(1, `hsl(${(frame + 180) % 360}, 60%, 30%)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 1920, 1080);
            
            ctx.fillStyle = 'white';
            ctx.font = 'bold 100px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('🎯 NATIVE STREAM', 960, 500);
            ctx.fillText(`Frame: ${frame}`, 960, 650);
            
            if (frame < 1800) requestAnimationFrame(animate); // 60 секунд
        }
        animate();
        
        const stream = canvas.captureStream(30);
        window.nativeTestStream = stream;
        
        ipcRenderer.send("preload-log", `✅ Stream created and saved to window.nativeTestStream`);
        
        // Пробуем найти и нажать кнопку
        setTimeout(() => {
            const btn = document.querySelector('button[onclick*="shareNativeStream"]');
            if (btn) {
                ipcRenderer.send("preload-log", "✅ Found shareNativeStream button, clicking...");
                btn.click();
            } else {
                ipcRenderer.send("preload-log", "⚠️ shareNativeStream button not found");
            }
        }, 1000);
        
        // Триггерим событие через electron_bridge
        if (window.electron_bridge) {
            electron_bridge.send_event("use-native-stream-in-jitsi", {
                streamId: stream.id,
                available: true
            });
            ipcRenderer.send("preload-log", "✅ Sent use-native-stream-in-jitsi event");
        }
        
    } catch (error) {
        ipcRenderer.send("preload-log", `❌ Error: ${error.message}`);
    }
}

// === JITSI CONFERENCE HANDLING ===
electron_bridge.on_event("jitsi-conference-started", async (data: {
    roomName: string;
    jwt?: string;
    userInfo?: {
        displayName: string;
        email: string;
        avatarUrl: string;
    }
}) => {
    ipcRenderer.send("preload-log", `🎯 Jitsi conference started in Zulip: ${data.roomName}`);

    const fullRoomUrl = `https://jitsi-connectrm.ru/${data.roomName}`;
    
    const result = await ipcRenderer.invoke("create-jitsi-sdk-from-zulip", {
        roomUrl: fullRoomUrl,
        roomName: data.roomName,
        jwt: data.jwt || "",
        userInfo: data.userInfo || {}
    });

    ipcRenderer.send("preload-log", `🎯 Conference window created: ${result.success}`);
});

// === NETWORK ERROR HANDLER ===
window.addEventListener("load", () => {
    if (!location.href.includes("app/renderer/network.html")) {
        return;
    }
    const $reconnectButton = document.querySelector("#reconnect")!;
    const $settingsButton = document.querySelector("#settings")!;
    NetworkError.init($reconnectButton, $settingsButton);
});

// === ФИНАЛЬНАЯ ПРОВЕРКА ===
ipcRenderer.send("preload-log", "====================================");
ipcRenderer.send("preload-log", "PRELOAD INITIALIZATION COMPLETE");
ipcRenderer.send("preload-log", `Context: ${window.location.hostname}`);
ipcRenderer.send("preload-log", `Platform: ${process.platform}`);
ipcRenderer.send("preload-log", `Process type: ${process.type}`);
ipcRenderer.send("preload-log", "====================================");