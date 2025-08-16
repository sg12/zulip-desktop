#include "audio_capture.h"
#include <thread>
#include <chrono>
#include <cmath>
#include <cstring>

// Определяем M_PI если его нет
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

class AudioCapture::Impl {
public:
    std::thread captureThread;
    bool isCapturing = false;
    AudioCallback callback;
    
    void CaptureLoop() {
        int sampleRate = 48000;
        int channels = 2;
        int samplesPerFrame = 480; // 10ms at 48kHz
        
        while (isCapturing) {
            // Генерируем тестовый синусоидальный сигнал
            float* samples = new float[samplesPerFrame * channels];
            
            static float phase = 0;
            float frequency = 440.0f; // A4 note
            
            for (int i = 0; i < samplesPerFrame; i++) {
                float sample = std::sin(phase) * 0.1f;
                samples[i * 2] = sample;     // Left
                samples[i * 2 + 1] = sample; // Right
                phase += 2.0f * M_PI * frequency / sampleRate;
                
                // Сброс фазы для предотвращения переполнения
                if (phase > 2.0f * M_PI) {
                    phase -= 2.0f * M_PI;
                }
            }
            
            if (callback) {
                callback(samples, samplesPerFrame, channels);
            }
            
            delete[] samples;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
};

AudioCapture::AudioCapture() : pImpl(std::make_unique<Impl>()) {}

AudioCapture::~AudioCapture() { 
    StopCapture(); 
}

void AudioCapture::StartCapture(AudioCallback callback) {
    pImpl->callback = callback;
    pImpl->isCapturing = true;
    pImpl->captureThread = std::thread([this]() {
        pImpl->CaptureLoop();
    });
}

void AudioCapture::StopCapture() {
    pImpl->isCapturing = false;
    if (pImpl->captureThread.joinable()) {
        pImpl->captureThread.join();
    }
}

bool AudioCapture::CaptureApplicationAudio(DWORD processId) {
    // Заглушка для кросс-компиляции
    return true;
}
