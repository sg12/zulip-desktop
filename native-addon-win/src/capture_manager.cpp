#include "capture_manager.h"
#include "screen_capture.h"
#include "audio_capture.h"
#include <thread>
#include <atomic>
#include <cstring>

class CaptureManager::Impl {
public:
    std::unique_ptr<ScreenCapture> screenCapture;
    std::unique_ptr<AudioCapture> audioCapture;
    std::atomic<bool> isCapturing{false};
    
    std::string sourceType;
    std::string sourceId;
    
    VideoCallback videoCallback;
    AudioCallback audioCallback;
    
    std::thread captureThread;
    
    Impl() {
        screenCapture = std::make_unique<ScreenCapture>();
        audioCapture = std::make_unique<AudioCapture>();
    }
};

CaptureManager::CaptureManager() : pImpl(std::make_unique<Impl>()) {}

CaptureManager::~CaptureManager() {
    StopCapture();
}

bool CaptureManager::SetCaptureSource(const std::string& type, const std::string& id) {
    pImpl->sourceType = type;
    pImpl->sourceId = id;
    
    if (type == "display" || type == "screen") {
        int monitorIndex = std::stoi(id);
        return pImpl->screenCapture->SelectMonitor(monitorIndex);
    } else if (type == "window") {
        HWND hwnd = reinterpret_cast<HWND>(std::stoull(id));
        return pImpl->screenCapture->SelectWindow(hwnd);
    }
    
    return false;
}

bool CaptureManager::StartCapture() {
    if (pImpl->isCapturing) return false;
    
    pImpl->isCapturing = true;
    
    // Запускаем захват видео
    pImpl->screenCapture->StartCapture([this](uint8_t* data, int width, int height) {
        if (pImpl->videoCallback) {
            int size = width * height * 4; // BGRA
            uint8_t* copiedData = new uint8_t[size];
            std::memcpy(copiedData, data, size);
            pImpl->videoCallback(copiedData, width, height, size);
        }
    });
    
    // Запускаем захват аудио
    pImpl->audioCapture->StartCapture([this](float* samples, int count, int channels) {
        if (pImpl->audioCallback) {
            pImpl->audioCallback(samples, count, channels);
        }
    });
    
    return true;
}

bool CaptureManager::StopCapture() {
    if (!pImpl->isCapturing) return false;
    
    pImpl->isCapturing = false;
    pImpl->screenCapture->StopCapture();
    pImpl->audioCapture->StopCapture();
    
    return true;
}

bool CaptureManager::StartApplicationAudioCapture(DWORD processId) {
    return pImpl->audioCapture->CaptureApplicationAudio(processId);
}

void CaptureManager::SetVideoCallback(VideoCallback callback) {
    pImpl->videoCallback = callback;
}

void CaptureManager::SetAudioCallback(AudioCallback callback) {
    pImpl->audioCallback = callback;
}

std::vector<SourceInfo> CaptureManager::GetAvailableSources() {
    std::vector<SourceInfo> sources;
    
    // Получаем мониторы
    auto monitors = pImpl->screenCapture->EnumerateMonitors();
    for (const auto& monitor : monitors) {
        sources.push_back({
            "display",
            std::to_string(monitor.index),
            monitor.name,
            monitor.width,
            monitor.height
        });
    }
    
    // Получаем окна
    auto windows = pImpl->screenCapture->EnumerateWindows();
    for (const auto& window : windows) {
        sources.push_back({
            "window",
            std::to_string(reinterpret_cast<uintptr_t>(window.hwnd)),
            window.title,
            window.width,
            window.height
        });
    }
    
    return sources;
}
