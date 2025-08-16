#pragma once
#include <functional>
#include <memory>
#include <cstdint>  // Добавляем для консистентности

#ifdef _WIN32
    #include <windows.h>
    #include <wrl/client.h>
    template<typename T>
    using ComPtr = Microsoft::WRL::ComPtr<T>;
#else
    typedef unsigned long DWORD;
    template<typename T>
    using ComPtr = std::shared_ptr<T>;
#endif

class AudioCapture {
public:
    using AudioCallback = std::function<void(float*, int, int)>;
    
    AudioCapture();
    ~AudioCapture();
    
    void StartCapture(AudioCallback callback);
    void StopCapture();
    bool CaptureApplicationAudio(DWORD processId);
    
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};