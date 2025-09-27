// audio-processor.js
// Вспомогательные функции для обработки аудио

class AudioProcessor {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        this.frameSize = 512;
    }
    
    // Конвертация стерео в моно
    stereoToMono(leftChannel, rightChannel) {
        const length = Math.min(leftChannel.length, rightChannel.length);
        const mono = new Float32Array(length);
        
        for (let i = 0; i < length; i++) {
            mono[i] = (leftChannel[i] + rightChannel[i]) / 2;
        }
        
        return mono;
    }
    
    // Конвертация моно в стерео
    monoToStereo(monoChannel) {
        const stereo = {
            left: new Float32Array(monoChannel),
            right: new Float32Array(monoChannel)
        };
        
        return stereo;
    }
    
    // Нормализация аудио
    normalize(audioBuffer, targetLevel = 0.7) {
        const maxValue = Math.max(...audioBuffer.map(Math.abs));
        
        if (maxValue === 0) {
            return audioBuffer;
        }
        
        const gain = targetLevel / maxValue;
        const normalized = new Float32Array(audioBuffer.length);
        
        for (let i = 0; i < audioBuffer.length; i++) {
            normalized[i] = audioBuffer[i] * gain;
        }
        
        return normalized;
    }
    
    // Применение окна (для спектрального анализа)
    applyWindow(signal, windowType = 'hanning') {
        const windowed = new Float32Array(signal.length);
        const N = signal.length;
        
        for (let n = 0; n < N; n++) {
            let w = 1.0;
            
            switch (windowType) {
                case 'hanning':
                    w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1));
                    break;
                case 'hamming':
                    w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N - 1));
                    break;
                case 'blackman':
                    w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)) 
                        + 0.08 * Math.cos(4 * Math.PI * n / (N - 1));
                    break;
            }
            
            windowed[n] = signal[n] * w;
        }
        
        return windowed;
    }
    
    // Вычисление RMS (среднеквадратичное значение)
    calculateRMS(signal) {
        let sum = 0;
        for (let i = 0; i < signal.length; i++) {
            sum += signal[i] * signal[i];
        }
        return Math.sqrt(sum / signal.length);
    }
    
    // Детектор голосовой активности (VAD)
    detectVoiceActivity(signal, threshold = 0.01) {
        const rms = this.calculateRMS(signal);
        return rms > threshold;
    }
    
    // Спектральное вычитание для шумоподавления
    spectralSubtraction(signal, noiseProfile) {
        // Упрощенная реализация
        const output = new Float32Array(signal.length);
        
        for (let i = 0; i < signal.length; i++) {
            const noise = noiseProfile ? noiseProfile[i] || 0 : 0;
            output[i] = signal[i] - noise * 0.5; // Вычитаем 50% шума
        }
        
        return output;
    }
    
    // Сглаживание переходов между блоками
    crossfade(prevBlock, currentBlock, fadeLength = 64) {
        if (!prevBlock || prevBlock.length < fadeLength) {
            return currentBlock;
        }
        
        const output = new Float32Array(currentBlock);
        
        for (let i = 0; i < fadeLength; i++) {
            const fadeIn = i / fadeLength;
            const fadeOut = 1 - fadeIn;
            output[i] = prevBlock[prevBlock.length - fadeLength + i] * fadeOut + currentBlock[i] * fadeIn;
        }
        
        return output;
    }
}

module.exports = AudioProcessor;