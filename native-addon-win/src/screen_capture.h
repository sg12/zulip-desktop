#pragma once
#include <vector>
#include <memory>
#include <functional>
#include <string>
#include <cstdint>  // Добавляем для uint8_t

#ifdef _WIN32
    #include <windows.h>
#else
    typedef void* HWND;
#endif

struct MonitorInfo {
    int index;
    std::string name;
    int width;
    int height;
};

struct WindowInfo {
    HWND hwnd;
    std::string title;
    int width;
    int height;
};

class ScreenCapture {
public:
    using FrameCallback = std::function<void(uint8_t*, int, int)>;
    
    ScreenCapture();
    ~ScreenCapture();
    
    bool SelectMonitor(int index);
    bool SelectWindow(HWND hwnd);
    void StartCapture(FrameCallback callback);
    void StopCapture();
    
    std::vector<MonitorInfo> EnumerateMonitors();
    std::vector<WindowInfo> EnumerateWindows();
    
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};