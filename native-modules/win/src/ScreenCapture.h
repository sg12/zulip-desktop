#pragma once
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <vector>
#include <string>

struct ScreenSource {
    std::string id;
    std::string name;
    std::string type;
    int width;
    int height;
};

class ScreenCapture {
public:
    ScreenCapture();
    ~ScreenCapture();
    
    std::vector<ScreenSource> GetSources();
    bool StartCapture(const std::string& sourceId);
    bool StopCapture();
    bool SetQuality(int width, int height, int fps);
    
private:
    bool isCapturing;
    // D3D11/DXGI члены
};