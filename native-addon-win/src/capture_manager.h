#pragma once
#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <cstdint>  // Добавляем для uint8_t

#ifdef _WIN32
    #include <windows.h>
#else
    // Mock типы для компиляции на Mac
    typedef void* HWND;
    typedef unsigned long DWORD;
#endif

struct SourceInfo {
    std::string type;
    std::string id;
    std::string name;
    int width;
    int height;
};

class CaptureManager {
public:
    using VideoCallback = std::function<void(uint8_t*, int, int, int)>;
    using AudioCallback = std::function<void(float*, int, int)>;
    
    CaptureManager();
    ~CaptureManager();
    
    bool SetCaptureSource(const std::string& type, const std::string& id);
    bool StartCapture();
    bool StopCapture();
    bool StartApplicationAudioCapture(DWORD processId);
    
    void SetVideoCallback(VideoCallback callback);
    void SetAudioCallback(AudioCallback callback);
    
    std::vector<SourceInfo> GetAvailableSources();
    
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};