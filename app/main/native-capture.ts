// native-capture.ts - Модуль для работы с native addon
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import * as path from "path";
import * as fs from "fs";
import log from "electron-log";

interface NativeCaptureState {
  addon: any;
  isCapturing: boolean;
  currentSourceId: string | null;
  videoFrameCount: number;
  audioFrameCount: number;
  callbacks: {
    video?: (data: any) => void;
    audio?: (data: any) => void;
  };
}

export interface CaptureQuality {
    width: number;
    height: number;
    fps: number;
}

export interface CapturePreset {
    name: string;
    quality: CaptureQuality;
    description: string;
}

// Предустановленные настройки качества
export const CAPTURE_PRESETS: { [key: string]: CapturePreset } = {
    ULTRALOW: {
        name: 'Очень низкое',
        quality: { width: 320, height: 240, fps: 15 },
        description: 'Экономия трафика, 480p @ 10fps'
    },
    LOW: {
        name: 'Низкое',
        quality: { width: 640, height: 480, fps: 15 },
        description: 'Экономия трафика, 480p @ 15fps'
    },
    MEDIUM: {
        name: 'Среднее',
        quality: { width: 1280, height: 720, fps: 10 },
        description: 'Оптимальный баланс, 720p @ 10fps'
    },
    HIGH: {
        name: 'Высокое',
        quality: { width: 1920, height: 1080, fps: 30 },
        description: 'Высокое качество, 1080p @ 30fps'
    },
    ULTRAHIGH: {
        name: 'Ультра',
        quality: { width: 2560, height: 1440, fps: 30 },
        description: 'Максимальное качество, 1440p @ 30fps'
    },
    PRESENTATION: {
        name: 'Презентация',
        quality: { width: 1920, height: 1080, fps: 5 },
        description: 'Для показа слайдов, 1080p @ 5fps'
    },
    SCREENSHARE: {
        name: 'Демонстрация экрана',
        quality: { width: 1920, height: 1080, fps: 15 },
        description: 'Для демонстрации экрана, 1080p @ 15fps'
    }
};

export class NativeCaptureManager {
    private state: NativeCaptureState;
    private currentQuality: CaptureQuality = CAPTURE_PRESETS.ULTRALOW.quality;

    constructor(addon?: any) {
        this.state = {
          addon: addon || null, // Используем переданный addon
          isCapturing: false,
          currentSourceId: null,
          videoFrameCount: 0,
          audioFrameCount: 0,
          callbacks: {}
      };

      if (!addon) {
          this.loadAddon(); // Загружаем только если не передан
      }
      this.registerHandlers();
    }

    // В native-capture.ts добавьте метод для audio-only режима
    async startAudioOnlyCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        try {
            // Устанавливаем минимальное качество видео (т.к. не используем)
            // Это снизит нагрузку на Swift addon
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                // Минимальное разрешение и FPS для экономии ресурсов
                this.state.addon.setCaptureQuality(320, 240, 1);
                log.info("Set minimal video quality for audio-only mode");
            }
            
            // Или если в Swift есть метод отключения видео
            if (typeof this.state.addon.setAudioOnlyMode === 'function') {
                this.state.addon.setAudioOnlyMode(true);
            }
            
            // Запускаем захват
            return this.startCapture(sourceId);
            
        } catch (error: any) {
            log.error(`Failed to start audio-only capture: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private loadAddon(): boolean {
      try {
        const possiblePaths = [
          path.join(__dirname, 'native-addon.node'),
          path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
          path.join(process.cwd(), 'dist-electron', 'native-addon.node'),
          '/Users/sg12/zulip-desktop/dist-electron/native-addon.node'
        ];
        
        let addonPath: string | null = null;
        for (const testPath of possiblePaths) {
          if (fs.existsSync(testPath)) {
            addonPath = testPath;
            break;
          }
        }
        
        if (!addonPath) {
          log.error(`Native addon not found in any of: ${possiblePaths.join(', ')}`);
          return false;
        }
        
        log.info(`Loading native addon from: ${addonPath}`);
        this.state.addon = require(addonPath);
        
        // Проверяем основные методы
        const requiredMethods = ['getAvailableSources', 'startCapture', 'stopCapture', 
                                'setWebRTCVideoCallback', 'setWebRTCAudioCallback'];
        const missingMethods = requiredMethods.filter(m => typeof this.state.addon[m] !== 'function');
        
        if (missingMethods.length > 0) {
          log.warn(`Native addon missing methods: ${missingMethods.join(', ')}`);
        }
        
        log.info(`✅ Native addon loaded successfully`);
        return true;
        
      } catch (error: any) {
        log.error(`❌ Failed to load native addon: ${error.message}`);
        return false;
      }
    }

    private registerHandlers(): void {
      // Получение списка источников
      ipcMain.handle("native-capture:get-sources", async () => {
        return this.getSources();
      });

      // Начало захвата
      ipcMain.handle("native-capture:start", async (event, sourceId: string) => {
        return this.startCapture(sourceId);
      });

      // Остановка захвата
      ipcMain.handle("native-capture:stop", async () => {
        return this.stopCapture();
      });

      // Получение статуса
      ipcMain.handle("native-capture:get-status", async () => {
        return {
          isCapturing: this.state.isCapturing,
          currentSourceId: this.state.currentSourceId,
          hasAddon: !!this.state.addon,
          videoFrames: this.state.videoFrameCount,
          audioFrames: this.state.audioFrameCount
        };
      });
    }

    private createDefaultThumbnail(): string {
      const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="300" height="200" fill="#9E9E9E"/>
        <text x="150" y="100" font-size="50" text-anchor="middle" fill="white">❓</text>
        <text x="150" y="140" font-size="16" text-anchor="middle" fill="white">Unknown Source</text>
      </svg>`;
      
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }

    async getSources(): Promise<any[]> {
      if (!this.state.addon) {
        log.error("Native addon not loaded");
        return [];
      }

      try {
        const sources = await this.state.addon.getAvailableSources();
        log.info(`Got ${sources?.length || 0} native sources from addon`);
        
        // ВАЖНО: Фильтруем и форматируем источники для безопасной передачи через IPC
        const formattedSources = sources.map((source: any, index: number) => {
          try {
            // Создаем безопасный объект без циклических ссылок и нестандартных типов
            const safeSource = {
              id: String(source.id || index),
              name: String(source.name || `Source ${index}`),
              type: String(source.type || 'unknown'),
              isNative: true,
              // Создаем thumbnail как простой объект с dataUrl строкой
              thumbnail: {
                dataUrl: this.createThumbnail(source)
              }
            };
            
            // Проверяем, что объект можно сериализовать
            JSON.stringify(safeSource);
            
            return safeSource;
            
          } catch (error: any) {
            log.error(`Error formatting source ${index}: ${error.message}`);
            // Возвращаем минимальный безопасный объект
            return {
              id: String(index),
              name: `Source ${index}`,
              type: 'unknown',
              isNative: true,
              thumbnail: {
                dataUrl: this.createDefaultThumbnail()
              }
            };
          }
        });
        
        log.info(`Formatted ${formattedSources.length} sources for IPC`);
        return formattedSources;
        
      } catch (error: any) {
        log.error(`Failed to get native sources: ${error.message}`);
        return [];
      }
    }

    async testAddonHealth(): Promise<{ healthy: boolean; details: string }> {
        if (!this.state.addon) {
            return { healthy: false, details: "Addon not loaded" };
        }
        
        const tests: string[] = [];
        
        // Проверяем основные методы
        const methods = [
            'setCaptureSource',           // Основной метод
            'setCaptureQuality',          // Установка качества (отдельно)
            'startCapture', 
            'stopCapture',
            'setWebRTCVideoCallback',
            'setWebRTCAudioCallback',
            'getAvailableSources'
        ];
        
        for (const method of methods) {
            if (typeof this.state.addon[method] === 'function') {
                tests.push(`✅ ${method}: exists`);
            } else {
                tests.push(`❌ ${method}: missing`);
            }
        }
        
        // Проверяем проблемный метод отдельно
        if (typeof this.state.addon.setCaptureSourceWithQuality === 'function') {
            tests.push(`⚠️ setCaptureSourceWithQuality: exists but may be broken`);
        }
        
        // Тест получения источников
        try {
            const sources = await this.state.addon.getAvailableSources();
            tests.push(`✅ getAvailableSources: returned ${sources?.length || 0} sources`);
        } catch (error: any) {
            tests.push(`❌ getAvailableSources error: ${error.message}`);
        }
        
        const details = tests.join('\n');
        const healthy = !tests.some(t => t.startsWith('❌'));
        
        log.info(`Native addon health check:\n${details}`);
        
        return { healthy, details };
    }

    async startCapture(sourceId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        if (this.state.isCapturing) {
            await this.stopCapture();
        }
        
        try {
            // Парсим sourceId
            let sourceType = 'display';
            let realSourceId = sourceId;
            
            log.info(`Raw sourceId: '${sourceId}'`);
            
            if (sourceId.includes(':')) {
                const parts = sourceId.split(':');
                log.info(`Split parts: ${JSON.stringify(parts)}`);
                
                if (parts[0] === 'screen' && parts.length >= 2) {
                    sourceType = 'display';
                    realSourceId = parts[1];
                } else if (parts[0] === 'window') {
                    sourceType = 'window';
                    realSourceId = parts[1];
                }
            }
            
            log.info(`Parsed - type: '${sourceType}', id: '${realSourceId}'`);
            log.info(`Current quality settings: ${JSON.stringify(this.currentQuality)}`);
            
            // Сбрасываем счетчики
            this.state.videoFrameCount = 0;
            this.state.audioFrameCount = 0;
            
            // Настраиваем колбэки
            this.setupCallbacks();
            
            // Устанавливаем качество
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                log.info(`Setting quality: ${this.currentQuality.width}x${this.currentQuality.height} @ ${this.currentQuality.fps}fps`);
                
                try {
                    this.state.addon.setCaptureQuality(
                        this.currentQuality.width,
                        this.currentQuality.height,
                        this.currentQuality.fps
                    );
                    log.info("✅ Quality set successfully");
                } catch (error: any) {
                    log.error(`Failed to set quality: ${error.message}`);
                }
            }
            
            // ВРЕМЕННЫЙ ОБХОДНОЙ ПУТЬ: используем числовую версию если доступна
            log.info(`Setting capture source...`);
            
            try {
                if (typeof this.state.addon.setCaptureSourceById === 'function') {
                    // Используем числовую версию
                    const sourceTypeNum = sourceType === 'display' ? 0 : 1;
                    const sourceIdNum = parseInt(realSourceId) || 1;
                    
                    log.info(`Using setCaptureSourceById with type=${sourceTypeNum}, id=${sourceIdNum}`);
                    const setResult = await this.state.addon.setCaptureSourceById(sourceTypeNum, sourceIdNum);
                    log.info(`setCaptureSourceById result: ${JSON.stringify(setResult)}`);
                    
                } else {
                    // Fallback на обычную версию (которая сейчас использует захардкоженные значения)
                    log.info(`Using setCaptureSource (simplified version)`);
                    const setResult = await this.state.addon.setCaptureSource(sourceType, realSourceId);
                    log.info(`setCaptureSource result: ${JSON.stringify(setResult)}`);
                }
            } catch (error: any) {
                log.error(`setCaptureSource failed: ${error.message}`);
                
                // В случае ошибки пробуем с дефолтными значениями
                log.info("Trying with default source...");
                try {
                    const fallbackResult = await this.state.addon.setCaptureSource('display', '1');
                    log.info(`Fallback result: ${JSON.stringify(fallbackResult)}`);
                } catch (fallbackError: any) {
                    log.error(`Fallback also failed: ${fallbackError.message}`);
                    throw fallbackError;
                }
            }
            
            // Запускаем захват
            log.info("Calling startCapture...");
            const startResult = await this.state.addon.startCapture();
            log.info(`startCapture result: ${JSON.stringify(startResult)}`);
            
            this.state.isCapturing = true;
            this.state.currentSourceId = sourceId;
            
            log.info(`✅ Capture started with quality: ${this.currentQuality.width}x${this.currentQuality.height} @ ${this.currentQuality.fps}fps`);
            return { success: true };
            
        } catch (error: any) {
            log.error(`Failed to start capture: ${error.message}`);
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            return { success: false, error: error.message };
        }
    }

    async testAddon(): Promise<void> {
        if (!this.state.addon) {
            log.error("Addon not loaded");
            return;
        }
        
        log.info("=== Testing Native Addon ===");
        log.info("Addon type:", typeof this.state.addon);
        log.info("Available methods:");
        
        for (const key of Object.keys(this.state.addon)) {
            const value = this.state.addon[key];
            const type = typeof value;
            if (type === 'function') {
                log.info(`  ${key}: function(${value.length} args)`);
            } else {
                log.info(`  ${key}: ${type}`);
            }
        }
        
        // Тест базового метода
        if (typeof this.state.addon.testMethod === 'function') {
            try {
                const result = this.state.addon.testMethod();
                log.info("Test method result:", result);
            } catch (e: any) {
                log.error("Test method error:", e.message);
            }
        }
    }

    async stopCapture(): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon || !this.state.isCapturing) {
            return { success: true };
        }

        try {
            // stopCapture тоже возвращает Promise
            const result = await this.state.addon.stopCapture();
            log.info(`Stop capture result: ${JSON.stringify(result)}`);
            
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            
            return { success: true };
            
        } catch (error: any) {
            log.error(`Failed to stop capture: ${error.message}`);
            
            // Force cleanup
            this.state.isCapturing = false;
            this.state.currentSourceId = null;
            
            return { success: false, error: error.message };
        }
    }

    private setupCallbacks(): void {
        if (!this.state.addon) return;

        // Видео колбэк с исправленной обработкой ArrayBuffer
        this.state.addon.setWebRTCVideoCallback((videoData: any) => {
            this.state.videoFrameCount++;
            
            // Детальная диагностика для первых кадров
            if (this.state.videoFrameCount <= 3) {
                log.info(`Video frame ${this.state.videoFrameCount} structure:`, {
                    hasDataField: 'data' in videoData,
                    dataType: typeof videoData?.data,
                    dataConstructor: videoData?.data?.constructor?.name,
                    dataByteLength: videoData?.data?.byteLength,
                    width: videoData?.width,
                    height: videoData?.height
                });
            }
            
            // ИСПРАВЛЕНИЕ: Правильно обрабатываем ArrayBuffer
            if (videoData && videoData.data) {
                // ArrayBuffer от N-API имеет свойство byteLength
                if (videoData.data.byteLength !== undefined && videoData.data.byteLength > 0) {
                    // ЭТО ArrayBuffer! Передаем его напрямую в callback
                    if (this.state.callbacks.video) {
                        const normalizedData = {
                            data: videoData.data, // ArrayBuffer передаем как есть
                            width: videoData?.width || 1920,
                            height: videoData?.height || 1080,
                            dataSize: videoData?.dataSize || videoData.data.byteLength,
                            timestamp: videoData?.timestamp || 0
                        };
                        
                        this.state.callbacks.video(normalizedData);
                        
                        if (this.state.videoFrameCount === 1) {
                            log.info("✅ First video frame sent to callback with ArrayBuffer");
                        }
                    }
                } else if (Buffer.isBuffer(videoData.data)) {
                    // Если это Buffer
                    if (this.state.callbacks.video) {
                        this.state.callbacks.video({
                            data: videoData.data,
                            width: videoData?.width || 1920,
                            height: videoData?.height || 1080,
                            dataSize: videoData?.dataSize || videoData.data.length,
                            timestamp: videoData?.timestamp || 0
                        });
                    }
                }
            } else if (this.state.videoFrameCount <= 3) {
                log.warn(`Frame ${this.state.videoFrameCount}: No data field`);
            }

            if (this.state.videoFrameCount % 30 === 0) {
                log.info(`Video frames: ${this.state.videoFrameCount}`);
            }
        });

        // Аудио колбэк - аналогично упрощаем
        this.state.addon.setWebRTCAudioCallback((audioData: any) => {
            this.state.audioFrameCount++;
            
            if (this.state.audioFrameCount === 1) {
                log.info("First audio frame:", {
                    hasData: !!audioData?.data,
                    dataByteLength: audioData?.data?.byteLength,
                    sampleRate: audioData?.sampleRate,
                    channels: audioData?.channels,
                    source: audioData?.source
                });
            }
            
            // Передаем ArrayBuffer напрямую
            if (audioData && audioData.data && audioData.data.byteLength > 0) {
                if (this.state.callbacks.audio) {
                    this.state.callbacks.audio({
                        data: audioData.data, // ArrayBuffer как есть
                        sampleRate: audioData?.sampleRate || 48000,
                        channels: audioData?.channels || 2,
                        numSamples: audioData?.numSamples || 960,
                        source: audioData?.source || 'unknown'
                    });
                    
                    if (this.state.audioFrameCount === 1) {
                        log.info("✅ First audio frame sent to callback");
                    }
                }
            }

            if (this.state.audioFrameCount % 100 === 0) {
                log.info(`Audio frames: ${this.state.audioFrameCount}`);
            }
        });
        
        log.info("Native capture callbacks setup complete");
    }

    // Установка внешних колбэков для обработки фреймов
    setFrameCallbacks(videoCallback?: (data: any) => void, audioCallback?: (data: any) => void): void {
      if (videoCallback) this.state.callbacks.video = videoCallback;
      if (audioCallback) this.state.callbacks.audio = audioCallback;
    }

    private createThumbnail(source: any): string {
      try {
        const colors: { [key: string]: string } = {
          screen: '#4CAF50',
          display: '#4CAF50',
          window: '#2196F3',
          application: '#FF9800'
        };
        
        const sourceType = String(source.type || 'unknown').toLowerCase();
        const color = colors[sourceType] || '#9E9E9E';
        const icon = (sourceType === 'screen' || sourceType === 'display') ? '🖥️' : '🪟';
        
        // Безопасное экранирование имени
        const safeName = String(source.name || 'Unknown')
          .replace(/[<>&"']/g, '')
          .substring(0, 50); // Ограничиваем длину
        
        const safeAppName = source.appName 
          ? String(source.appName)
              .replace(/[<>&"']/g, '')
              .substring(0, 50)
          : '';
        
        const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
          <rect width="300" height="200" fill="${color}"/>
          <text x="150" y="80" font-size="50" text-anchor="middle" fill="white">${icon}</text>
          <text x="150" y="130" font-size="16" text-anchor="middle" fill="white" font-weight="bold">
            ${safeName}
          </text>
          ${safeAppName ? `
            <text x="150" y="155" font-size="14" text-anchor="middle" fill="white" opacity="0.9">
              ${safeAppName}
            </text>
          ` : ''}
          <rect x="20" y="180" width="260" height="3" rx="1.5" fill="white" opacity="0.2"/>
          <rect x="20" y="180" width="130" height="3" rx="1.5" fill="white" opacity="0.6"/>
        </svg>`;
        
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        
      } catch (error: any) {
        log.error(`Error creating thumbnail: ${error.message}`);
        return this.createDefaultThumbnail();
      }
    }

    // Геттер для проверки состояния
    get isAvailable(): boolean {
      return !!this.state.addon;
    }

    get isCapturing(): boolean {
      return this.state.isCapturing;
    }

  // Установка качества захвата
    async setCaptureQuality(quality: CaptureQuality): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        try {
            // Валидация параметров
            const validatedQuality = {
                width: Math.max(320, Math.min(3840, quality.width)),
                height: Math.max(240, Math.min(2160, quality.height)),
                fps: Math.max(5, Math.min(60, quality.fps))
            };
            
            log.info(`Setting capture quality: ${validatedQuality.width}x${validatedQuality.height} @ ${validatedQuality.fps}fps`);
            
            // Проверяем наличие метода
            if (typeof this.state.addon.setCaptureQuality === 'function') {
                const result = this.state.addon.setCaptureQuality(
                    validatedQuality.width,
                    validatedQuality.height,
                    validatedQuality.fps
                );
                
                this.currentQuality = validatedQuality;
                log.info(`Capture quality set: ${result}`);
                return { success: true };
            } else {
                log.warn("setCaptureQuality method not found in addon");
                return { success: false, error: "Method not available" };
            }
            
        } catch (error: any) {
            log.error(`Failed to set capture quality: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    // Использовать предустановку качества
    async useQualityPreset(presetName: keyof typeof CAPTURE_PRESETS): Promise<{ success: boolean; error?: string }> {
        const preset = CAPTURE_PRESETS[presetName];
        if (!preset) {
            return { success: false, error: `Unknown preset: ${presetName}` };
        }
        
        log.info(`📐 Using quality preset: ${preset.name} - ${preset.description}`);
        log.info(`📐 Setting quality to: ${preset.quality.width}x${preset.quality.height} @ ${preset.quality.fps}fps`);
        
        // Сохраняем качество локально
        this.currentQuality = { ...preset.quality };
        
        // И отправляем в Swift если захват уже идет
        if (this.state.isCapturing && this.state.addon && typeof this.state.addon.setCaptureQuality === 'function') {
            try {
                this.state.addon.setCaptureQuality(
                    preset.quality.width,
                    preset.quality.height,
                    preset.quality.fps
                );
                log.info("✅ Quality updated in Swift during active capture");
            } catch (error: any) {
                log.error(`Failed to update quality in Swift: ${error.message}`);
            }
        }
        
        return { success: true };
    }
    
    // Запуск захвата с указанным качеством
    async startCaptureWithQuality(
        sourceId: string, 
        quality?: CaptureQuality
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.state.addon) {
            return { success: false, error: "Native addon not loaded" };
        }
        
        // Если качество указано, устанавливаем его
        if (quality) {
            this.currentQuality = { ...quality };
            log.info(`Setting custom quality: ${quality.width}x${quality.height} @ ${quality.fps}fps`);
        }
        
        // Используем обычный startCapture, который уже умеет работать с currentQuality
        return this.startCapture(sourceId);
    }
    
    // Получить текущие настройки качества
    getCurrentQuality(): CaptureQuality {
        return { ...this.currentQuality };
    }
    
    // Изменить качество во время захвата
    async updateQualityDuringCapture(quality: CaptureQuality): Promise<{ success: boolean; error?: string }> {
        if (!this.state.isCapturing) {
            // Если захват не идет, просто сохраняем настройки
            return this.setCaptureQuality(quality);
        }
        
        log.info("Updating quality during capture...");
        
        // В зависимости от возможностей Swift, можем либо:
        // 1. Перезапустить захват с новыми параметрами
        // 2. Изменить качество на лету (если Swift поддерживает)
        
        const currentSourceId = this.state.currentSourceId;
        if (!currentSourceId) {
            return { success: false, error: "No active capture source" };
        }
        
        // Останавливаем текущий захват
        await this.stopCapture();
        
        // Запускаем с новым качеством
        return this.startCaptureWithQuality(currentSourceId, quality);
    }
}

export default NativeCaptureManager;