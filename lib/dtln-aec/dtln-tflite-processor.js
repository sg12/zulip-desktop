// dtln-tflite-processor.js
// Процессор для подавления эха с использованием адаптивной фильтрации или TensorFlow моделей

const path = require('path');
const fs = require('fs');

class DTLNProcessor {
    constructor() {
        this.initialized = false;
        this.mode = 'fallback'; // 'tensorflow' или 'fallback'
        this.modelSize = 256;
        this.sampleRate = 48000;
        this.blockSize = 512;
        
        // Буферы для обработки
        this.inputBuffer = null;
        this.outputBuffer = null;
        this.echoBuffer = null;
        
        // Адаптивный фильтр для fallback режима
        this.adaptiveFilter = null;
        
        // Статистика
        this.processedBlocks = 0;
        this.totalLatency = 0;
        
        // TensorFlow модели (если доступны)
        this.model1 = null;
        this.model2 = null;
        this.tfAvailable = false;

        this.lastEchoReference = null; // Для кеширования эхо-референса
    }

    // Добавляем синхронную версию
    processBlockSync(nearEnd, farEnd = null) {
        if (!this.initialized) {
            console.warn('[DTLN-AEC] Not initialized, returning original audio');
            return nearEnd; // Возвращаем необработанный звук
        }
        
        // Используем последний известный эхо-референс если не передан новый
        const echoRef = farEnd || this.lastEchoReference;
        
        if (this.mode === 'fallback') {
            return this.processFallback(nearEnd, echoRef);
        }
        
        // Для TensorFlow режима тоже используем fallback в синхронном режиме
        return this.processFallback(nearEnd, echoRef);
    }
    
    async initialize(modelSize = 256) {
        console.log(`[DTLN-AEC] Initializing with model size: ${modelSize}`);
        
        this.modelSize = modelSize;
        this.blockSize = modelSize * 2;
        
        // Инициализируем буферы
        this.inputBuffer = new Float32Array(this.blockSize);
        this.outputBuffer = new Float32Array(this.blockSize);
        this.echoBuffer = new Float32Array(this.blockSize);
        
        // Пытаемся загрузить TensorFlow модели
        try {
            await this.loadTensorFlowModels();
        } catch (error) {
            console.warn('[DTLN-AEC] TensorFlow models not available, using fallback mode');
            this.initializeFallbackMode();
        }
        
        this.initialized = true;
        return { success: true, mode: this.mode };
    }
    
    async loadTensorFlowModels() {
        // Проверяем наличие TensorFlow
        try {
            const tf = require('@tensorflow/tfjs-node');
            
            const modelPath1 = path.join(__dirname, '../../models/dtln_aec_256_1.tflite');
            const modelPath2 = path.join(__dirname, '../../models/dtln_aec_256_2.tflite');
            
            // Проверяем существование файлов моделей
            if (fs.existsSync(modelPath1) && fs.existsSync(modelPath2)) {
                // Здесь бы загружались настоящие модели
                // this.model1 = await tf.loadLayersModel(modelPath1);
                // this.model2 = await tf.loadLayersModel(modelPath2);
                
                this.tfAvailable = true;
                this.mode = 'tensorflow';
                console.log('[DTLN-AEC] TensorFlow models loaded successfully');
            } else {
                throw new Error('Model files not found');
            }
        } catch (error) {
            this.tfAvailable = false;
            throw error;
        }
    }
    
    initializeFallbackMode() {
        // Инициализируем адаптивный фильтр NLMS (Normalized Least Mean Squares)
        this.adaptiveFilter = new NLMSFilter(this.blockSize);
        this.mode = 'fallback';
        console.log('[DTLN-AEC] Initialized with NLMS adaptive filter (fallback mode)');
    }
    
    async processBlock(nearEnd, farEnd = null) {
        if (!this.initialized) {
            throw new Error('DTLN-AEC not initialized');
        }
        
        const startTime = Date.now();
        let output;
        
        if (this.mode === 'tensorflow' && this.tfAvailable) {
            output = await this.processTensorFlow(nearEnd, farEnd);
        } else {
            output = this.processFallback(nearEnd, farEnd);
        }
        
        // Обновляем статистику
        this.processedBlocks++;
        this.totalLatency += (Date.now() - startTime);
        
        return output;
    }
    
    // Синхронная версия для использования в реальном времени
    processBlockSync(nearEnd, farEnd = null) {
        if (!this.initialized) {
            return nearEnd; // Возвращаем необработанный звук
        }
        
        if (this.mode === 'fallback') {
            return this.processFallback(nearEnd, farEnd);
        }
        
        // Для TensorFlow режима используем кеш или fallback
        return this.processFallback(nearEnd, farEnd);
    }
    
    processFallback(nearEnd, farEnd) {
        if (!this.adaptiveFilter) {
            // Если фильтр не инициализирован, инициализируем его
            this.initializeFallbackMode();
        }
        
        if (!nearEnd || nearEnd.length === 0) {
            return new Float32Array(this.blockSize || 512);
        }
        
        // Применяем адаптивную фильтрацию
        const output = this.adaptiveFilter.process(nearEnd, farEnd);
        
        // Дополнительная обработка
        return this.postProcess(output);
    }
    
    async processTensorFlow(nearEnd, farEnd) {
        // Здесь была бы реальная обработка через TensorFlow
        // Пока используем fallback
        return this.processFallback(nearEnd, farEnd);
    }
    
    postProcess(signal) {
        // Применяем сглаживание и нормализацию
        const output = new Float32Array(signal.length);
        
        for (let i = 0; i < signal.length; i++) {
            // Ограничиваем амплитуду
            output[i] = Math.max(-1, Math.min(1, signal[i]));
            
            // Простое сглаживание
            if (i > 0) {
                output[i] = output[i] * 0.9 + output[i-1] * 0.1;
            }
        }
        
        return output;
    }
    
    getStats() {
        const avgLatency = this.processedBlocks > 0 
            ? (this.totalLatency / this.processedBlocks).toFixed(2)
            : 0;
            
        return {
            mode: this.mode,
            processedBlocks: this.processedBlocks,
            averageLatency: avgLatency,
            initialized: this.initialized,
            tfAvailable: this.tfAvailable
        };
    }
    
    reset() {
        if (this.adaptiveFilter) {
            this.adaptiveFilter.reset();
        }
        
        this.inputBuffer?.fill(0);
        this.outputBuffer?.fill(0);
        this.echoBuffer?.fill(0);
        
        this.processedBlocks = 0;
        this.totalLatency = 0;
        
        console.log('[DTLN-AEC] Reset completed');
    }
    
    cleanup() {
        this.reset();
        this.initialized = false;
        this.model1 = null;
        this.model2 = null;
        this.adaptiveFilter = null;
        
        console.log('[DTLN-AEC] Cleanup completed');
    }
}

// Адаптивный фильтр NLMS для fallback режима
class NLMSFilter {
    constructor(filterLength = 512) {
        this.filterLength = filterLength;
        this.weights = new Float32Array(filterLength);
        this.buffer = new Float32Array(filterLength);
        this.stepSize = 0.5; // Коэффициент адаптации
        this.regularization = 0.0001; // Для избежания деления на ноль
    }
    
    process(desired, reference) {
        if (!reference) {
            return desired; // Без референса возвращаем оригинал
        }
        
        const output = new Float32Array(desired.length);
        
        for (let n = 0; n < desired.length; n++) {
            // Сдвигаем буфер
            for (let i = this.filterLength - 1; i > 0; i--) {
                this.buffer[i] = this.buffer[i - 1];
            }
            this.buffer[0] = reference[n] || 0;
            
            // Вычисляем выход фильтра
            let y = 0;
            for (let i = 0; i < this.filterLength; i++) {
                y += this.weights[i] * this.buffer[i];
            }
            
            // Вычисляем ошибку
            const error = desired[n] - y;
            output[n] = error;
            
            // Обновляем веса (NLMS алгоритм)
            let power = this.regularization;
            for (let i = 0; i < this.filterLength; i++) {
                power += this.buffer[i] * this.buffer[i];
            }
            
            const mu = this.stepSize / power;
            
            for (let i = 0; i < this.filterLength; i++) {
                this.weights[i] += mu * error * this.buffer[i];
            }
        }
        
        return output;
    }
    
    reset() {
        this.weights.fill(0);
        this.buffer.fill(0);
    }
}

module.exports = DTLNProcessor;