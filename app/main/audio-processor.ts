// audio-processor.ts - Модуль обработки аудио для нативного захвата
import log from "electron-log";

// ===== КЛАСС КОЛЬЦЕВОГО БУФЕРА =====
export class RingBuffer {
    buffer: Float32Array;
    writeIndex: number = 0;
    readIndex: number = 0;
    availableSamples: number = 0;
    size: number;
    
    constructor(size: number) {
        this.buffer = new Float32Array(size);
        this.size = size;
        log.info(`[RingBuffer] Created with size: ${size}`);
    }
    
    write(data: Float32Array): number {
        let written = 0;
        for (let i = 0; i < data.length && written < this.size; i++) {
            this.buffer[this.writeIndex] = data[i];
            this.writeIndex = (this.writeIndex + 1) % this.size;
            this.availableSamples = Math.min(this.availableSamples + 1, this.size);
            written++;
        }
        return written;
    }
    
    read(output: Float32Array): number {
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
    
    clear(): void {
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.availableSamples = 0;
    }
}

// ===== ИНТЕРФЕЙСЫ И ТИПЫ =====
export interface AudioLevels {
    maxLeft: number;
    maxRight: number;
    hasAudio: boolean;
}

export interface DecodedAudio {
    leftChannel: Float32Array;
    rightChannel: Float32Array;
}

export interface ProcessedAudio {
    processedLeft: Float32Array;
    processedRight: Float32Array;
}

// ===== КЛАСС ОБРАБОТКИ АУДИО =====
export class AudioProcessor {
    private platform: NodeJS.Platform;
    
    constructor() {
        this.platform = process.platform;
        log.info(`[AudioProcessor] Initialized for platform: ${this.platform}`);
    }
    
    /**
     * Декодирует аудио данные для Windows платформы
     * Windows использует INTERLEAVED формат (L,R,L,R,L,R...)
     */
    decodeWindowsAudio(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): DecodedAudio {
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
    
    /**
     * Декодирует аудио данные для macOS платформы
     * macOS использует ПЛАНАРНЫЙ формат (все L, затем все R)
     */
    decodeMacOSAudio(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): DecodedAudio {
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
    
    /**
     * Декодирует аудио в зависимости от платформы
     */
    decodeAudio(
        arrayBuffer: ArrayBuffer, 
        samples: number, 
        channels: number
    ): DecodedAudio {
        if (this.isWindowsPlatform()) {
            return this.decodeWindowsAudio(arrayBuffer, samples, channels);
        } else {
            return this.decodeMacOSAudio(arrayBuffer, samples, channels);
        }
    }
    
    /**
     * Анализирует уровни аудио сигнала
     */
    analyzeAudioLevels(
        leftChannel: Float32Array, 
        rightChannel: Float32Array
    ): AudioLevels {
        let maxLeft = 0, maxRight = 0;
        
        for (let i = 0; i < leftChannel.length; i++) {
            maxLeft = Math.max(maxLeft, Math.abs(leftChannel[i]));
            maxRight = Math.max(maxRight, Math.abs(rightChannel[i]));
        }
        
        const hasAudio = maxLeft > 0.00001 || maxRight > 0.00001;
        
        return { maxLeft, maxRight, hasAudio };
    }
    
    /**
     * Нормализует аудио сигнал
     */
    normalizeAudio(
        leftChannel: Float32Array,
        rightChannel: Float32Array,
        levels: AudioLevels
    ): ProcessedAudio {
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
    
    /**
     * Проверяет платформу
     */
    isWindowsPlatform(): boolean {
        return this.platform === 'win32';
    }
    
    /**
     * Получает количество сэмплов для платформы
     */
    getSamplesForPlatform(audioData: any): number {
        return this.isWindowsPlatform() 
            ? (audioData.numSamples || 480)  // Windows: 480 samples
            : (audioData.numSamples || 960); // macOS: 960 samples
    }
}

// ===== КОД ДЛЯ ИНЖЕКЦИИ В JITSI ОКНО =====

/**
 * Возвращает код класса RingBuffer для инжекции в Jitsi окно
 */
export function getRingBufferCode(): string {
    return `
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
    `;
}

/**
 * Возвращает код класса ParticipantAudioMixer для инжекции в Jitsi окно
 */
export function getParticipantAudioMixerCode(): string {
    return `
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
    `;
}

/**
 * Генерирует код для отправки аудио данных в буферы Jitsi
 */
export function getSendAudioToJitsiCode(leftData: Float32Array, rightData: Float32Array, samples: number): string {
    // Для больших массивов ограничиваем первые 1000 сэмплов для производительности
    const leftSamples = Array.from(leftData.slice(0, Math.min(1000, samples)));
    const rightSamples = Array.from(rightData.slice(0, Math.min(1000, samples)));
    
    return `
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
                const leftSamples = [${leftSamples.join(',')}];
                const rightSamples = [${rightSamples.join(',')}];
                
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
}