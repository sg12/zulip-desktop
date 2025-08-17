// app/main/native-addon-wrapper.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

// Интерфейс для унификации методов между Mac и Windows
export interface UnifiedNativeAddon {
    // Базовые методы
    testMethod?: () => string;
    testBasic?: () => string;
    
    // Методы получения источников
    getAvailableSources: () => Promise<any[]> | any[];
    
    // Методы управления захватом
    setCaptureSource: (type: string, id: string) => any;
    setCaptureSourceById?: (typeNum: number, idNum: number) => any;
    setCaptureQuality: (width: number, height: number, fps: number) => any;
    startCapture: () => any;
    stopCapture: () => any;
    
    // Оптимизированные методы
    startAudioOnlyCapture?: () => any;
    startAudioVideoCapture?: () => any;
    
    // Callbacks
    setWebRTCVideoCallback: (callback: (data: any) => void) => void;
    setWebRTCAudioCallback: (callback: (data: any) => void) => void;
    
    // Дополнительные методы
    getStreamState?: () => any;
    forceStopCapture?: () => any;
    resetCapture?: () => any;
    getFrameStats?: () => any;
}

export class NativeAddonWrapper {
    private addon: UnifiedNativeAddon | null = null;
    private rawAddon: any = null;
    private platform: string;
    private isLoaded: boolean = false;
    private addonPath: string | null = null;
    private audioFrameCount: number = 0;
    private videoFrameCount: number = 0;

    constructor() {
        this.platform = process.platform;
        this.loadAddon();
    }

    private loadAddon(): void {
        try {
            // Определяем имя файла и пути в зависимости от платформы
            const configs = {
                darwin: {
                    fileName: 'native-addon.node',
                    paths: [
                        path.join(__dirname, 'native-addon.node'),
                        path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
                        path.join(process.cwd(), 'dist-electron', 'native-addon.node'),
                        '/Users/sg12/zulip-desktop/dist-electron/native-addon.node',
                        path.join(process.cwd(), 'native-modules', 'mac', 'addon.node')
                    ]
                },
                win32: {
                    fileName: 'screen_capture_win.node',
                    paths: [
                        path.join(__dirname, 'screen_capture_win.node'),
                        path.join(__dirname, '..', 'dist-electron', 'screen_capture_win.node'),
                        path.join(process.cwd(), 'dist-electron', 'screen_capture_win.node'),
                        path.join(process.cwd(), 'native-modules', 'win', 'build', 'Release', 'screen_capture_win.node'),
                        path.join(process.cwd(), 'native-modules', 'win', 'build', 'screen_capture_win.node')
                    ]
                },
                linux: {
                    fileName: 'native-addon.node',
                    paths: [
                        path.join(__dirname, 'native-addon.node'),
                        path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
                        path.join(process.cwd(), 'dist-electron', 'native-addon.node')
                    ]
                }
            };

            const config = configs[this.platform as keyof typeof configs] || configs.linux;

            // Ищем файл
            for (const testPath of config.paths) {
                if (fs.existsSync(testPath)) {
                    this.addonPath = testPath;
                    break;
                }
            }

            if (!this.addonPath) {
                throw new Error(`Native addon not found. Searched paths: ${config.paths.join(', ')}`);
            }

            log.info(`[NativeAddonWrapper] Loading from: ${this.addonPath}`);
            this.rawAddon = require(this.addonPath);
            
            // Создаем унифицированный интерфейс
            this.addon = this.createUnifiedAddon(this.rawAddon);
            
            this.isLoaded = true;
            
            // Проверяем наличие методов
            this.validateAddon();
            
            log.info(`✅ [NativeAddonWrapper] Loaded successfully for ${this.platform}`);
            
        } catch (error: any) {
            log.error(`❌ [NativeAddonWrapper] Failed to load: ${error.message}`);
            this.addon = null;
            this.isLoaded = false;
            
            // Создаем mock реализацию для fallback
            this.createMockAddon();
        }
    }

    private createUnifiedAddon(rawAddon: any): UnifiedNativeAddon {
        // Для macOS используем специальную обработку callbacks
        if (this.platform === 'darwin') {
            return {
                testMethod: rawAddon.testMethod,
                testBasic: rawAddon.testBasic,
                getAvailableSources: rawAddon.getAvailableSources,
                setCaptureSource: rawAddon.setCaptureSource,
                setCaptureSourceById: rawAddon.setCaptureSourceById,
                setCaptureQuality: rawAddon.setCaptureQuality,
                startCapture: rawAddon.startCapture,
                stopCapture: rawAddon.stopCapture,
                startAudioOnlyCapture: rawAddon.startAudioOnlyCapture,
                startAudioVideoCapture: rawAddon.startAudioVideoCapture,
                getFrameStats: rawAddon.getFrameStats,
                
                // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Обработка video callback
                setWebRTCVideoCallback: (callback: (data: any) => void) => {
                    if (rawAddon.setWebRTCVideoCallback) {
                        rawAddon.setWebRTCVideoCallback((frameData: any) => {
                            this.videoFrameCount++;
                            
                            // Проверяем формат данных
                            if (this.videoFrameCount <= 3) {
                                log.info(`[Video Frame ${this.videoFrameCount}] Structure:`, {
                                    hasData: !!frameData?.data,
                                    dataType: typeof frameData?.data,
                                    dataByteLength: frameData?.data?.byteLength,
                                    width: frameData?.width,
                                    height: frameData?.height
                                });
                            }
                            
                            // Передаем данные дальше
                            callback(frameData);
                        });
                    }
                },
                
                // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Обработка audio callback
                // В методе createUnifiedAddon для macOS, секция setWebRTCAudioCallback
                setWebRTCAudioCallback: (callback: (data: any) => void) => {
                    if (rawAddon.setWebRTCAudioCallback) {
                        rawAddon.setWebRTCAudioCallback((audioData: any) => {
                            this.audioFrameCount++;
                            
                            // Согласно README, плагин возвращает объект с полем data (ArrayBuffer)
                            // и метаданными. Убеждаемся, что передаем данные правильно
                            
                            if (this.audioFrameCount <= 3) {
                                log.info(`[Audio Frame ${this.audioFrameCount}] Structure:`, {
                                    hasData: !!audioData?.data,
                                    dataType: audioData?.data?.constructor?.name,
                                    byteLength: audioData?.data?.byteLength || audioData?.dataByteLength,
                                    sampleRate: audioData?.sampleRate,
                                    channels: audioData?.channels,
                                    numSamples: audioData?.numSamples,
                                    source: audioData?.source
                                });
                            }
                            
                            // ВАЖНО: Передаем данные как есть, без излишней нормализации
                            // Плагин уже возвращает правильную структуру согласно README
                            if (audioData && audioData.data instanceof ArrayBuffer) {
                                callback(audioData);
                                
                                if (this.audioFrameCount === 1) {
                                    log.info('✅ Audio data passed through correctly');
                                }
                            } else {
                                log.error(`⚠️ Invalid audio data format in frame ${this.audioFrameCount}`);
                            }
                            
                            if (this.audioFrameCount % 100 === 0) {
                                log.info(`Audio frames: ${this.audioFrameCount}, Last size: ${audioData?.data?.byteLength} bytes`);
                            }
                        });
                    }
                }
            };
        }
        
        // Для Windows модуля может потребоваться адаптация
        if (this.platform === 'win32') {
            return {
                testMethod: () => {
                    if (rawAddon.testMethod) return rawAddon.testMethod();
                    if (rawAddon.testBasic) return rawAddon.testBasic();
                    return "Windows module loaded";
                },

                getAvailableSources: async () => {
                    if (!rawAddon.getAvailableSources) return [];
                    
                    const sources = await rawAddon.getAvailableSources();
                    // Нормализуем формат для Windows если нужно
                    return sources.map((source: any, index: number) => ({
                        id: source.id || `${source.type || 'screen'}:${index}:0`,
                        name: source.name || `Source ${index}`,
                        type: source.type || 'screen',
                        width: source.width || 1920,
                        height: source.height || 1080,
                        appName: source.appName,
                        platform: 'windows'
                    }));
                },

                setCaptureSource: (type: string, id: string) => {
                    if (rawAddon.setCaptureSource) {
                        return rawAddon.setCaptureSource(type, id);
                    }
                    return { success: false, error: "Method not available" };
                },

                setCaptureSourceById: rawAddon.setCaptureSourceById,

                setCaptureQuality: (width: number, height: number, fps: number) => {
                    if (rawAddon.setCaptureQuality) {
                        return rawAddon.setCaptureQuality(width, height, fps);
                    }
                    return { success: false };
                },

                startCapture: () => {
                    if (rawAddon.startCapture) {
                        return rawAddon.startCapture();
                    }
                    return { success: false };
                },

                stopCapture: () => {
                    if (rawAddon.stopCapture) {
                        return rawAddon.stopCapture();
                    }
                    return { success: false };
                },

                setWebRTCVideoCallback: (callback: (data: any) => void) => {
                    // Windows модуль может использовать другое имя
                    if (rawAddon.setVideoCallback) {
                        rawAddon.setVideoCallback(callback);
                    } else if (rawAddon.setWebRTCVideoCallback) {
                        rawAddon.setWebRTCVideoCallback(callback);
                    }
                },

                setWebRTCAudioCallback: (callback: (data: any) => void) => {
                    if (rawAddon.setWebRTCAudioCallback) {
                        rawAddon.setWebRTCAudioCallback((audioData: any) => {
                            this.audioFrameCount++;
                            
                            // Детальная проверка данных от Swift
                            if (audioData?.data instanceof ArrayBuffer) {
                                const float32 = new Float32Array(audioData.data);
                                let maxVal = 0;
                                let hasSound = false;
                                
                                for (let i = 0; i < float32.length; i++) {
                                    const absVal = Math.abs(float32[i]);
                                    maxVal = Math.max(maxVal, absVal);
                                    if (absVal > 0.0001) {
                                        hasSound = true;
                                    }
                                }
                                
                                if (hasSound) {
                                    nonZeroFrameCount++;
                                } else {
                                    zeroFrameCount++;
                                }
                                
                                // Логируем статистику каждые 100 кадров
                                if (this.audioFrameCount % 100 === 0) {
                                    const percentWithSound = (nonZeroFrameCount / (zeroFrameCount + nonZeroFrameCount) * 100).toFixed(1);
                                    log.info(`[Swift Audio Stats]: Frames with sound: ${nonZeroFrameCount}, silent: ${zeroFrameCount} (${percentWithSound}% have sound)`);
                                    
                                    if (percentWithSound < 10) {
                                        log.error('⚠️ WARNING: Less than 10% of frames from Swift contain audio!');
                                    }
                                }
                                
                                // Логируем детали для первых кадров и кадров с звуком
                                if (this.audioFrameCount <= 5 || (hasSound && this.audioFrameCount % 50 === 0)) {
                                    log.info(`[Swift Frame ${this.audioFrameCount}]:`, {
                                        hasSound: hasSound,
                                        maxValue: maxVal.toFixed(8),
                                        source: audioData.source,
                                        byteLength: audioData.data.byteLength
                                    });
                                }
                            }
                            
                            // Передаем данные дальше
                            callback(audioData);
                        });
                    }
                },

                getFrameStats: rawAddon.getFrameStats,
                startAudioOnlyCapture: rawAddon.startAudioOnlyCapture,
                startAudioVideoCapture: rawAddon.startAudioVideoCapture
            };
        }
        
        // Для других платформ
        return rawAddon as UnifiedNativeAddon;
    }

    private validateAddon(): void {
        if (!this.addon) return;

        const requiredMethods = [
            'getAvailableSources',
            'setCaptureSource',
            'setCaptureQuality', 
            'startCapture',
            'stopCapture',
            'setWebRTCVideoCallback',
            'setWebRTCAudioCallback'
        ];

        const availableMethods: string[] = [];
        const missingMethods: string[] = [];

        for (const method of requiredMethods) {
            if (typeof (this.addon as any)[method] === 'function') {
                availableMethods.push(method);
            } else {
                missingMethods.push(method);
            }
        }

        log.info(`[NativeAddonWrapper] Platform: ${this.platform}`);
        log.info(`[NativeAddonWrapper] Available methods: ${availableMethods.join(', ')}`);
        
        if (missingMethods.length > 0) {
            log.warn(`[NativeAddonWrapper] Missing methods: ${missingMethods.join(', ')}`);
        }

        // Проверяем оптимизированные методы
        const optimizedMethods = ['startAudioOnlyCapture', 'startAudioVideoCapture'];
        const hasOptimized = optimizedMethods.filter(m => 
            typeof (this.addon as any)[m] === 'function'
        );
        
        if (hasOptimized.length > 0) {
            log.info(`🚀 [NativeAddonWrapper] Optimized methods available: ${hasOptimized.join(', ')}`);
        }
    }

    private createMockAddon(): void {
        log.info('[NativeAddonWrapper] Creating mock implementation...');
        
        this.addon = {
            testMethod: () => `Mock addon (${this.platform})`,
            
            getAvailableSources: async () => {
                return [
                    {
                        id: 'screen:1:0',
                        name: 'Primary Display (Mock)',
                        type: 'screen',
                        width: 1920,
                        height: 1080,
                        platform: this.platform
                    },
                    {
                        id: 'window:1001:0',
                        name: 'Test Window (Mock)',
                        type: 'window',
                        width: 1024,
                        height: 768,
                        platform: this.platform
                    }
                ];
            },
            
            setCaptureSource: (type: string, id: string) => {
                log.info(`[MockAddon] Set source: ${type}:${id}`);
                return { success: true };
            },
            
            setCaptureQuality: (width: number, height: number, fps: number) => {
                log.info(`[MockAddon] Set quality: ${width}x${height}@${fps}`);
                return { success: true };
            },
            
            startCapture: () => {
                log.info('[MockAddon] Start capture');
                return { success: true };
            },
            
            stopCapture: () => {
                log.info('[MockAddon] Stop capture');
                return { success: true };
            },
            
            setWebRTCVideoCallback: (callback: any) => {
                log.info('[MockAddon] Video callback set');
                // Генерируем тестовые данные
                setInterval(() => {
                    const mockData = {
                        data: new ArrayBuffer(1920 * 1080 * 4),
                        width: 1920,
                        height: 1080,
                        timestamp: Date.now()
                    };
                    callback(mockData);
                }, 100);
            },
            
            setWebRTCAudioCallback: (callback: any) => {
                log.info('[MockAddon] Audio callback set');
                setInterval(() => {
                    const mockData = {
                        data: new ArrayBuffer(960 * 2 * 4),
                        sampleRate: 48000,
                        channels: 2,
                        numSamples: 960,
                        hasData: true,
                        dataByteLength: 960 * 2 * 4,
                        source: 'mock'
                    };
                    callback(mockData);
                }, 20);
            }
        };
    }

    // Публичные методы
    public getAddon(): UnifiedNativeAddon | null {
        return this.addon;
    }

    public isAvailable(): boolean {
        return this.isLoaded && this.addon !== null;
    }

    public getPlatform(): string {
        return this.platform;
    }

    public getStatus(): any {
        const methods = this.addon ? Object.keys(this.addon).filter(key => 
            typeof (this.addon as any)[key] === 'function'
        ) : [];

        return {
            loaded: this.isLoaded,
            platform: this.platform,
            path: this.addonPath,
            available: this.isAvailable(),
            methodCount: methods.length,
            methods: methods,
            audioFrames: this.audioFrameCount,
            videoFrames: this.videoFrameCount
        };
    }
}

// Singleton экспорт
export const nativeAddonWrapper = new NativeAddonWrapper();