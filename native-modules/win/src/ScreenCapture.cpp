#include "ScreenCapture.h"

ScreenCapture::ScreenCapture() : isCapturing(false) {
    // Инициализация D3D11/DXGI
}

ScreenCapture::~ScreenCapture() {
    StopCapture();
}

std::vector<ScreenSource> ScreenCapture::GetSources() {
    std::vector<ScreenSource> sources;
    
    // Mock реализация для начала
    sources.push_back({
        "1",
        "Primary Display",
        "screen",
        1920,
        1080
    });
    
    return sources;
}

bool ScreenCapture::StartCapture(const std::string& sourceId) {
    // TODO: Реализация захвата
    isCapturing = true;
    return true;
}

bool ScreenCapture::StopCapture() {
    isCapturing = false;
    return true;
}

bool ScreenCapture::SetQuality(int width, int height, int fps) {
    // TODO: Установка качества
    return true;
}