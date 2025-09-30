#define NOMINMAX
#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <audiopolicy.h>
#include <propvarutil.h>
#include <thread>
#include <atomic>
#include <vector>
#include <memory>
#include <dwmapi.h>
#include <psapi.h>
#include <algorithm>
#include <string>
#include <chrono>
#include <mutex>
#include <cstring>
#include <cmath>
#include <functiondiscoverykeys_devpkey.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "propsys.lib")

#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif

// Global callbacks
static napi_threadsafe_function g_video_tsfn = nullptr;
static napi_threadsafe_function g_audio_tsfn = nullptr;
static std::atomic<uint64_t> g_video_frame_count{0};
static std::atomic<uint64_t> g_audio_frame_count{0};
static std::atomic<bool> g_capture_active{false};

// Data structures
struct VideoFrameData {
    uint8_t* data;
    int width;
    int height;
    double timestamp;
    bool hasRealPixels;
    size_t dataSize;
};

struct AudioFrameData {
    float* samples;
    int numSamples;
    int sampleRate;
    int channels;
    double timestamp;
    bool isSystemAudio;
    std::string applicationName;
};

struct CaptureSource {
    std::string type;
    std::string id;
    std::string name;
    int width;
    int height;
};

// Quality settings
struct QualitySettings {
    int width = 1;
    int height = 1;
    int fps = 1;
    std::mutex mutex;
} g_quality;

// Window enumeration data
struct EnumWindowsData {
    std::vector<CaptureSource>* sources;
};

// Simple synchronization manager
struct SimpleSyncManager {
    LARGE_INTEGER frequency;
    LARGE_INTEGER startTime;
    double audioLatencyMs = 0.0;
    double videoLatencyMs = 0.0;
    bool initialized = false;
    
    void Initialize() {
        QueryPerformanceFrequency(&frequency);
        QueryPerformanceCounter(&startTime);
        initialized = true;
        audioLatencyMs = 15.0;
        videoLatencyMs = 7.0;
    }
    
    double GetTimestamp() {
        if (!initialized) Initialize();
        
        LARGE_INTEGER currentTime;
        QueryPerformanceCounter(&currentTime);
        
        double elapsedSeconds = (double)(currentTime.QuadPart - startTime.QuadPart) 
                               / (double)frequency.QuadPart;
        return elapsedSeconds * 1000.0;
    }
    
    double GetAudioTimestamp() {
        return GetTimestamp() - audioLatencyMs;
    }
    
    double GetVideoTimestamp() {
        return GetTimestamp() - videoLatencyMs;
    }
    
    void Reset() {
        QueryPerformanceCounter(&startTime);
    }
};

static SimpleSyncManager g_syncManager;

// Minimal video capture for compatibility
class DXGIScreenCapture {
private:
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;
    IDXGIOutputDuplication* duplication = nullptr;
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    
public:
    bool Initialize(int displayId) {
        D3D_FEATURE_LEVEL featureLevels[] = {
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1
        };
        
        D3D_FEATURE_LEVEL featureLevel;
        HRESULT hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            &device,
            &featureLevel,
            &context
        );
        
        if (FAILED(hr)) return false;
        
        IDXGIDevice* dxgiDevice = nullptr;
        hr = device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice);
        if (FAILED(hr)) return false;
        
        IDXGIAdapter* adapter = nullptr;
        hr = dxgiDevice->GetAdapter(&adapter);
        dxgiDevice->Release();
        if (FAILED(hr)) return false;
        
        IDXGIOutput* output = nullptr;
        hr = adapter->EnumOutputs(displayId, &output);
        adapter->Release();
        if (FAILED(hr)) return false;
        
        IDXGIOutput1* output1 = nullptr;
        hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
        output->Release();
        if (FAILED(hr)) return false;
        
        hr = output1->DuplicateOutput(device, &duplication);
        output1->Release();
        
        return SUCCEEDED(hr);
    }
    
    void SetQuality(int width, int height, int fps) {
        // Intentionally minimal
    }
    
    void StartCapture() {
        isCapturing = true;
        captureThread = std::thread([this]() {
            CaptureLoop();
        });
    }
    
    void CaptureLoop() {
        while (isCapturing) {
            VideoFrameData* frameData = new VideoFrameData();
            frameData->width = 1;
            frameData->height = 1;
            frameData->timestamp = g_syncManager.GetVideoTimestamp();
            frameData->hasRealPixels = false;
            frameData->dataSize = 4;
            frameData->data = new uint8_t[4]{0, 0, 0, 255};
            
            if (g_video_tsfn) {
                napi_call_threadsafe_function(
                    g_video_tsfn,
                    frameData,
                    napi_tsfn_nonblocking
                );
            } else {
                delete[] frameData->data;
                delete frameData;
            }
            
            Sleep(1000);
        }
    }
    
    void StopCapture() {
        isCapturing = false;
        if (captureThread.joinable()) {
            captureThread.join();
        }
    }
    
    ~DXGIScreenCapture() {
        StopCapture();
        if (duplication) duplication->Release();
        if (context) context->Release();
        if (device) device->Release();
    }
};

// TEST: Synthetic click sound generator instead of real audio capture
class ApplicationAudioCapture {
private:
    DWORD targetProcessId = 0;
    std::wstring applicationName;
    
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    
    const int SAMPLE_RATE = 48000;
    const int CHANNELS = 2;
    const int TARGET_FRAME_SIZE = 960;
    
    // Click sound generation parameters
    double clickPhase = 0.0;
    double lastClickTime = 0.0;
    const double CLICK_INTERVAL_MS = 500.0; // Click every 500ms
    const double CLICK_FREQUENCY = 1000.0; // 1kHz click
    const double CLICK_DURATION_MS = 10.0; // 10ms click duration
    
    LARGE_INTEGER performanceFrequency;
    LARGE_INTEGER captureStartTime;
    
public:
    bool InitializeForApplication(HWND hwnd) {
        CoInitialize(nullptr);
        
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        
        GetWindowThreadProcessId(hwnd, &targetProcessId);
        
        // Get application name for display
        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, targetProcessId);
        if (hProcess) {
            wchar_t exePath[MAX_PATH];
            DWORD pathLen = MAX_PATH;
            if (QueryFullProcessImageNameW(hProcess, 0, exePath, &pathLen)) {
                std::wstring fullPath(exePath);
                size_t lastSlash = fullPath.find_last_of(L"\\/");
                if (lastSlash != std::wstring::npos) {
                    applicationName = fullPath.substr(lastSlash + 1);
                }
            }
            CloseHandle(hProcess);
        }
        
        OutputDebugStringA("TEST MODE: Initialized synthetic click generator for application\n");
        return true;
    }
    
    bool InitializeForSystemAudio() {
        CoInitialize(nullptr);
        
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        
        OutputDebugStringA("TEST MODE: Initialized synthetic click generator for system\n");
        return true;
    }
    
    void StartCapture() {
        isCapturing = true;
        lastClickTime = 0.0;
        clickPhase = 0.0;
        
        captureThread = std::thread([this]() {
            CoInitialize(nullptr);
            GenerateClickLoop();
            CoUninitialize();
        });
        
        OutputDebugStringA("TEST MODE: Started synthetic click generation\n");
    }
    
    void GenerateClickLoop() {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        
        while (isCapturing) {
            // Generate audio frame with clicks
            AudioFrameData* frameData = new AudioFrameData();
            frameData->numSamples = TARGET_FRAME_SIZE;
            frameData->sampleRate = SAMPLE_RATE;
            frameData->channels = CHANNELS;
            frameData->timestamp = g_syncManager.GetAudioTimestamp();
            frameData->isSystemAudio = (targetProcessId == 0);
            
            if (!applicationName.empty()) {
                char appName[256] = {0};
                wcstombs(appName, applicationName.c_str(), sizeof(appName) - 1);
                frameData->applicationName = appName;
                frameData->applicationName += " [TEST CLICKS]";
            } else {
                frameData->applicationName = "System [TEST CLICKS]";
            }
            
            // Allocate and generate samples
            size_t totalSamples = TARGET_FRAME_SIZE * CHANNELS;
            frameData->samples = new float[totalSamples];
            
            // Generate click sound
            GenerateClickSamples(frameData->samples, TARGET_FRAME_SIZE);
            
            g_audio_frame_count++;
            
            if (g_audio_tsfn) {
                napi_status status = napi_call_threadsafe_function(
                    g_audio_tsfn,
                    frameData,
                    napi_tsfn_nonblocking
                );
                
                if (status != napi_ok) {
                    delete[] frameData->samples;
                    delete frameData;
                    break;
                }
            } else {
                delete[] frameData->samples;
                delete frameData;
            }
            
            // Sleep to maintain approximate sample rate
            // TARGET_FRAME_SIZE samples at SAMPLE_RATE Hz
            int sleepMs = (TARGET_FRAME_SIZE * 1000) / SAMPLE_RATE;
            Sleep(sleepMs);
        }
    }
    
    void GenerateClickSamples(float* samples, int numFrames) {
        double currentTime = g_syncManager.GetTimestamp();
        
        for (int i = 0; i < numFrames; i++) {
            float sample = 0.0f;
            
            // Check if we should generate a click
            double sampleTime = currentTime + (i * 1000.0 / SAMPLE_RATE);
            double timeSinceLastClick = sampleTime - lastClickTime;
            
            // Start a new click
            if (timeSinceLastClick >= CLICK_INTERVAL_MS) {
                lastClickTime = sampleTime;
                clickPhase = 0.0;
            }
            
            // Generate click if we're within click duration
            if (sampleTime - lastClickTime < CLICK_DURATION_MS) {
                // Simple sine wave click with envelope
                double envelope = 1.0 - ((sampleTime - lastClickTime) / CLICK_DURATION_MS);
                envelope = envelope * envelope; // Quadratic decay
                
                sample = (float)(sin(clickPhase) * envelope * 0.5);
                clickPhase += 2.0 * M_PI * CLICK_FREQUENCY / SAMPLE_RATE;
                
                // Keep phase in reasonable range
                if (clickPhase > 2.0 * M_PI) {
                    clickPhase -= 2.0 * M_PI;
                }
            }
            
            // Write to both channels
            for (int ch = 0; ch < CHANNELS; ch++) {
                samples[i * CHANNELS + ch] = sample;
            }
        }
    }
    
    void StopCapture() {
        isCapturing = false;
        
        if (captureThread.joinable()) {
            captureThread.join();
        }
        
        OutputDebugStringA("TEST MODE: Stopped synthetic click generation\n");
    }
    
    ~ApplicationAudioCapture() {
        StopCapture();
        CoUninitialize();
    }
};

// Global capture instances
static std::unique_ptr<DXGIScreenCapture> g_screenCapture;
static std::unique_ptr<ApplicationAudioCapture> g_appAudioCapture;
static CaptureSource g_currentSource;

// Window enumeration callback
BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    if (!IsWindowVisible(hwnd)) return TRUE;
    
    char windowTitle[256];
    GetWindowTextA(hwnd, windowTitle, sizeof(windowTitle));
    
    if (strlen(windowTitle) == 0) return TRUE;
    
    DWORD style = GetWindowLong(hwnd, GWL_STYLE);
    DWORD exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
    
    if ((style & WS_CHILD) || (exStyle & WS_EX_TOOLWINDOW)) return TRUE;
    if (!(style & WS_VISIBLE)) return TRUE;
    
    RECT rect;
    GetWindowRect(hwnd, &rect);
    int width = rect.right - rect.left;
    int height = rect.bottom - rect.top;
    
    if (width < 100 || height < 100) return TRUE;
    
    DWORD cloaked = 0;
    HRESULT hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (SUCCEEDED(hr) && cloaked != 0) return TRUE;
    
    DWORD processId;
    GetWindowThreadProcessId(hwnd, &processId);
    
    std::string processName = "";
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (hProcess) {
        char exePath[MAX_PATH];
        DWORD pathLen = MAX_PATH;
        if (QueryFullProcessImageNameA(hProcess, 0, exePath, &pathLen)) {
            std::string fullPath(exePath);
            size_t lastSlash = fullPath.find_last_of("\\/");
            if (lastSlash != std::string::npos) {
                processName = fullPath.substr(lastSlash + 1);
                size_t dotPos = processName.find_last_of(".");
                if (dotPos != std::string::npos) {
                    processName = processName.substr(0, dotPos);
                }
            }
        }
        CloseHandle(hProcess);
    }
    
    auto* data = (EnumWindowsData*)lParam;
    
    CaptureSource source;
    source.type = "window";
    source.id = std::to_string((intptr_t)hwnd);
    source.name = std::string(windowTitle);
    if (!processName.empty()) {
        source.name += " (" + processName + ")";
    }
    source.width = width;
    source.height = height;
    
    data->sources->push_back(source);
    
    return TRUE;
}

// === N-API Functions ===

napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, "Windows Audio Capture Module v3.0 TEST MODE - Synthetic Click Generator", NAPI_AUTO_LENGTH, &result);
    return result;
}

napi_value GetAvailableSources(napi_env env, napi_callback_info info) {
    napi_value array;
    napi_create_array(env, &array);
    
    std::vector<CaptureSource> sources;
    
    // Enumerate displays
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    
    if (SUCCEEDED(hr)) {
        UINT adapterIndex = 0;
        IDXGIAdapter1* adapter = nullptr;
        
        while (factory->EnumAdapters1(adapterIndex, &adapter) != DXGI_ERROR_NOT_FOUND) {
            UINT outputIndex = 0;
            IDXGIOutput* output = nullptr;
            
            while (adapter->EnumOutputs(outputIndex, &output) != DXGI_ERROR_NOT_FOUND) {
                DXGI_OUTPUT_DESC desc;
                output->GetDesc(&desc);
                
                char monitorName[32];
                wcstombs(monitorName, desc.DeviceName, sizeof(monitorName));
                
                CaptureSource source;
                source.type = "screen";
                source.id = std::to_string(outputIndex);
                source.name = "Display " + std::to_string(outputIndex + 1) + " (" + std::string(monitorName) + ")";
                source.width = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
                source.height = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;
                
                sources.push_back(source);
                
                output->Release();
                outputIndex++;
            }
            
            adapter->Release();
            adapterIndex++;
        }
        
        factory->Release();
    }
    
    // Add entire screen option
    RECT virtualScreen;
    virtualScreen.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    virtualScreen.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    virtualScreen.right = virtualScreen.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    virtualScreen.bottom = virtualScreen.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    
    CaptureSource entireScreen;
    entireScreen.type = "screen";
    entireScreen.id = "entire_screen";
    entireScreen.name = "Entire Screen (All Displays)";
    entireScreen.width = virtualScreen.right - virtualScreen.left;
    entireScreen.height = virtualScreen.bottom - virtualScreen.top;
    sources.push_back(entireScreen);
    
    // Enumerate windows
    EnumWindowsData enumData;
    enumData.sources = &sources;
    EnumWindows(EnumWindowsProc, (LPARAM)&enumData);
    
    // Convert to JavaScript array
    for (size_t i = 0; i < sources.size(); i++) {
        napi_value obj;
        napi_create_object(env, &obj);
        
        napi_value type, id, name, width, height;
        napi_create_string_utf8(env, sources[i].type.c_str(), NAPI_AUTO_LENGTH, &type);
        napi_create_string_utf8(env, sources[i].id.c_str(), NAPI_AUTO_LENGTH, &id);
        napi_create_string_utf8(env, sources[i].name.c_str(), NAPI_AUTO_LENGTH, &name);
        napi_create_int32(env, sources[i].width, &width);
        napi_create_int32(env, sources[i].height, &height);
        
        napi_set_named_property(env, obj, "type", type);
        napi_set_named_property(env, obj, "id", id);
        napi_set_named_property(env, obj, "name", name);
        napi_set_named_property(env, obj, "width", width);
        napi_set_named_property(env, obj, "height", height);
        
        napi_set_element(env, array, i, obj);
    }
    
    return array;
}

napi_value SetCaptureSource(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected source object");
        return nullptr;
    }
    
    napi_value typeVal, idVal;
    napi_get_named_property(env, argv[0], "type", &typeVal);
    napi_get_named_property(env, argv[0], "id", &idVal);
    
    char type[256], id[256];
    size_t typeLen, idLen;
    napi_get_value_string_utf8(env, typeVal, type, sizeof(type), &typeLen);
    napi_get_value_string_utf8(env, idVal, id, sizeof(id), &idLen);
    
    g_currentSource.type = type;
    g_currentSource.id = id;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

napi_value SetCaptureQuality(napi_env env, napi_callback_info info) {
    // Intentionally minimal for CPU optimization
    {
        std::lock_guard<std::mutex> lock(g_quality.mutex);
        g_quality.width = 1;
        g_quality.height = 1;
        g_quality.fps = 1;
    }
    
    if (g_screenCapture) {
        g_screenCapture->SetQuality(1, 1, 1);
    }
    
    napi_value result;
    napi_create_object(env, &result);
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

napi_value StartCapture(napi_env env, napi_callback_info info) {
    g_syncManager.Initialize();
    g_syncManager.Reset();
    OutputDebugStringA("Sync manager initialized\n");
    
    if (g_screenCapture) {
        g_screenCapture->StopCapture();
        g_screenCapture.reset();
    }
    if (g_appAudioCapture) {
        g_appAudioCapture->StopCapture();
        g_appAudioCapture.reset();
    }
    
    bool videoStarted = false;
    bool audioStarted = false;
    
    // Start minimal video capture
    if (g_currentSource.type == "screen" || 
        g_currentSource.type == "display" || 
        g_currentSource.type == "window") {
        int displayId = 0;
        try {
            displayId = std::stoi(g_currentSource.id);
        } catch (...) {
            displayId = 0;
        }
        
        g_screenCapture = std::make_unique<DXGIScreenCapture>();
        if (g_screenCapture->Initialize(displayId)) {
            std::lock_guard<std::mutex> lock(g_quality.mutex);
            g_screenCapture->SetQuality(g_quality.width, g_quality.height, g_quality.fps);
            
            g_screenCapture->StartCapture();
            videoStarted = true;
        }
    }
    
    // Start synthetic audio generation
    if (g_currentSource.type == "window") {
        try {
            HWND hwnd = (HWND)std::stoull(g_currentSource.id);
            
            if (IsWindow(hwnd)) {
                g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
                
                if (g_appAudioCapture->InitializeForApplication(hwnd)) {
                    g_appAudioCapture->StartCapture();
                    audioStarted = true;
                    OutputDebugStringA("TEST MODE: Started synthetic click generation for application\n");
                }
            }
        } catch (...) {
            OutputDebugStringA("Exception in window audio initialization\n");
        }
    } else {
        g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
        if (g_appAudioCapture->InitializeForSystemAudio()) {
            g_appAudioCapture->StartCapture();
            audioStarted = true;
            OutputDebugStringA("TEST MODE: Started synthetic click generation for system\n");
        }
    }
    
    g_capture_active = videoStarted || audioStarted;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, videoStarted || audioStarted, &success);
    napi_set_named_property(env, result, "success", success);
    
    napi_value message;
    std::string msg = "TEST MODE Started: ";
    if (videoStarted) msg += "video ";
    if (audioStarted) msg += "audio (synthetic clicks)";
    napi_create_string_utf8(env, msg.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_set_named_property(env, result, "message", message);
    
    return result;
}

napi_value StopCapture(napi_env env, napi_callback_info info) {
    g_capture_active = false;
    
    if (g_screenCapture) {
        g_screenCapture->StopCapture();
        g_screenCapture.reset();
    }
    
    if (g_appAudioCapture) {
        g_appAudioCapture->StopCapture();
        g_appAudioCapture.reset();
    }
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

napi_value SetWebRTCVideoCallback(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected callback function");
        return nullptr;
    }
    
    if (g_video_tsfn) {
        napi_release_threadsafe_function(g_video_tsfn, napi_tsfn_release);
        g_video_tsfn = nullptr;
    }
    
    napi_value work_name;
    napi_create_string_utf8(env, "WebRTCVideoCallback", NAPI_AUTO_LENGTH, &work_name);
    
    napi_create_threadsafe_function(
        env,
        argv[0],
        nullptr,
        work_name,
        0,
        1,
        nullptr,
        nullptr,
        nullptr,
        [](napi_env env, napi_value js_callback, void* context, void* data) {
            VideoFrameData* frameData = (VideoFrameData*)data;
            
            napi_value videoInfo;
            napi_create_object(env, &videoInfo);
            
            napi_value width, height, timestamp, hasRealPixels, frameNumber;
            napi_create_int32(env, frameData->width, &width);
            napi_create_int32(env, frameData->height, &height);
            napi_create_double(env, frameData->timestamp, &timestamp);
            napi_get_boolean(env, frameData->hasRealPixels, &hasRealPixels);
            napi_create_double(env, (double)g_video_frame_count.load(), &frameNumber);
            
            napi_set_named_property(env, videoInfo, "width", width);
            napi_set_named_property(env, videoInfo, "height", height);
            napi_set_named_property(env, videoInfo, "timestamp", timestamp);
            napi_set_named_property(env, videoInfo, "hasRealPixels", hasRealPixels);
            napi_set_named_property(env, videoInfo, "frameNumber", frameNumber);
            
            if (frameData->hasRealPixels && frameData->data) {
                void* buffer_data;
                napi_value arrayBuffer;
                napi_create_arraybuffer(env, frameData->dataSize, &buffer_data, &arrayBuffer);
                memcpy(buffer_data, frameData->data, frameData->dataSize);
                napi_set_named_property(env, videoInfo, "data", arrayBuffer);
            }
            
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_status status = napi_call_function(env, global, js_callback, 1, &videoInfo, &result);
            
            delete[] frameData->data;
            delete frameData;
        },
        &g_video_tsfn
    );
    
    napi_value result;
    napi_create_string_utf8(env, "WebRTC video callback set", NAPI_AUTO_LENGTH, &result);
    return result;
}

napi_value SetWebRTCAudioCallback(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected callback function");
        return nullptr;
    }
    
    if (g_audio_tsfn) {
        napi_release_threadsafe_function(g_audio_tsfn, napi_tsfn_release);
        g_audio_tsfn = nullptr;
    }
    
    napi_value work_name;
    napi_create_string_utf8(env, "WebRTCAudioCallback", NAPI_AUTO_LENGTH, &work_name);
    
    napi_create_threadsafe_function(
        env,
        argv[0],
        nullptr,
        work_name,
        0,
        1,
        nullptr,
        nullptr,
        nullptr,
        [](napi_env env, napi_value js_callback, void* context, void* data) {
            AudioFrameData* frameData = (AudioFrameData*)data;
            
            napi_value audioInfo;
            napi_create_object(env, &audioInfo);
            
            napi_value sampleRate, channels, timestamp, numSamples, frameNumber, source;
            napi_create_int32(env, frameData->sampleRate, &sampleRate);
            napi_create_int32(env, frameData->channels, &channels);
            napi_create_double(env, frameData->timestamp, &timestamp);
            napi_create_int32(env, frameData->numSamples, &numSamples);
            napi_create_double(env, (double)g_audio_frame_count.load(), &frameNumber);
            napi_create_string_utf8(env, frameData->isSystemAudio ? "system" : "application", 
                                   NAPI_AUTO_LENGTH, &source);
            
            napi_set_named_property(env, audioInfo, "sampleRate", sampleRate);
            napi_set_named_property(env, audioInfo, "channels", channels);
            napi_set_named_property(env, audioInfo, "timestamp", timestamp);
            napi_set_named_property(env, audioInfo, "numSamples", numSamples);
            napi_set_named_property(env, audioInfo, "frameNumber", frameNumber);
            napi_set_named_property(env, audioInfo, "source", source);
            
            if (!frameData->applicationName.empty()) {
                napi_value appName;
                napi_create_string_utf8(env, frameData->applicationName.c_str(), 
                                       NAPI_AUTO_LENGTH, &appName);
                napi_set_named_property(env, audioInfo, "applicationName", appName);
            }
            
            if (frameData->samples) {
                void* buffer_data;
                napi_value arrayBuffer;
                size_t dataSize = frameData->numSamples * frameData->channels * sizeof(float);
                napi_create_arraybuffer(env, dataSize, &buffer_data, &arrayBuffer);
                memcpy(buffer_data, frameData->samples, dataSize);
                napi_set_named_property(env, audioInfo, "data", arrayBuffer);
                
                napi_value dataSizeVal;
                napi_create_double(env, (double)dataSize, &dataSizeVal);
                napi_set_named_property(env, audioInfo, "dataSize", dataSizeVal);
            }
            
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_status status = napi_call_function(env, global, js_callback, 1, &audioInfo, &result);
            
            delete[] frameData->samples;
            delete frameData;
        },
        &g_audio_tsfn
    );
    
    napi_value result;
    napi_create_string_utf8(env, "WebRTC audio callback set (TEST MODE)", NAPI_AUTO_LENGTH, &result);
    return result;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"testMethod", nullptr, TestMethod, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getAvailableSources", nullptr, GetAvailableSources, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startCapture", nullptr, StartCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopCapture", nullptr, StopCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setCaptureQuality", nullptr, SetCaptureQuality, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setCaptureSource", nullptr, SetCaptureSource, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCVideoCallback", nullptr, SetWebRTCVideoCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCAudioCallback", nullptr, SetWebRTCAudioCallback, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)