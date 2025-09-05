#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <audiopolicy.h>
#include <thread>
#include <atomic>
#include <vector>
#include <memory>
#include <dwmapi.h>
#include <psapi.h>
#include "audio_format.h" 
#include <algorithm>
#include <string>
#include <chrono>
#include <mutex>
#include <cstring>
#include <cmath>
#include <set>
#include <map>

#include <ks.h>
#include <ksmedia.h>
#include <functiondiscoverykeys_devpkey.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "psapi.lib")

// Определение DWMWA_CLOAKED если его нет
#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif

#ifndef KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
#endif

#ifndef KSDATAFORMAT_SUBTYPE_PCM  
const GUID KSDATAFORMAT_SUBTYPE_PCM = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
#endif

#ifndef WAVE_FORMAT_IEEE_FLOAT
#define WAVE_FORMAT_IEEE_FLOAT 0x0003
#endif

#ifndef WAVE_FORMAT_EXTENSIBLE
#define WAVE_FORMAT_EXTENSIBLE 0xFFFE
#endif

#ifndef WAVE_FORMAT_PCM
#define WAVE_FORMAT_PCM 0x0001
#endif

// Глобальные переменные для callbacks
static napi_threadsafe_function g_video_tsfn = nullptr;
static napi_threadsafe_function g_audio_tsfn = nullptr;
static std::atomic<uint64_t> g_video_frame_count{0};
static std::atomic<uint64_t> g_audio_frame_count{0};
static std::atomic<bool> g_capture_active{false};

// Структуры для передачи данных
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

// Структура для хранения информации об источнике
struct CaptureSource {
    std::string type;
    std::string id;
    std::string name;
    int width;
    int height;
};

// Глобальные параметры качества
struct QualitySettings {
    int width = 1920;
    int height = 1080;
    int fps = 30;
    std::mutex mutex;
} g_quality;

// Структура для передачи данных в callback перечисления окон
struct EnumWindowsData {
    std::vector<CaptureSource>* sources;
};

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

double GetTimestamp() {
    return g_syncManager.GetTimestamp();
}

// Класс для захвата экрана через DXGI
class DXGIScreenCapture {
private:
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;
    IDXGIOutputDuplication* duplication = nullptr;
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    int targetWidth = 1920;
    int targetHeight = 1080;
    int targetFps = 30;
    LARGE_INTEGER performanceFrequency;
    LARGE_INTEGER captureStartTime;
    
public:
    bool Initialize(int displayId) {
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        OutputDebugStringA("DXGIScreenCapture::Initialize starting\n");
        
        D3D_FEATURE_LEVEL featureLevels[] = {
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0
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
        
        if (FAILED(hr)) {
            char log[128];
            sprintf_s(log, "D3D11CreateDevice failed: 0x%08X\n", hr);
            OutputDebugStringA(log);
            return false;
        }
        
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
        
        if (SUCCEEDED(hr)) {
            OutputDebugStringA("DXGIScreenCapture::Initialize SUCCESS\n");
        } else {
            char log[128];
            sprintf_s(log, "DXGIScreenCapture::Initialize FAILED: 0x%08X\n", hr);
            OutputDebugStringA(log);
        }
        
        return SUCCEEDED(hr);
    }

    double GetPreciseVideoTimestamp() {
        LARGE_INTEGER currentTime;
        QueryPerformanceCounter(&currentTime);
        
        double elapsed = (double)(currentTime.QuadPart - captureStartTime.QuadPart);
        return (elapsed / performanceFrequency.QuadPart) * 1000.0;
    }
    
    void SetQuality(int width, int height, int fps) {
        targetWidth = width;
        targetHeight = height;
        targetFps = fps;
    }
    
    void StartCapture() {
        isCapturing = true;
        captureThread = std::thread([this]() {
            CaptureLoop();
        });
    }
    
    void CaptureLoop() {
        int frameInterval = 1000 / targetFps;
        
        while (isCapturing) {
            auto frameStart = std::chrono::high_resolution_clock::now();
            
            IDXGIResource* desktopResource = nullptr;
            DXGI_OUTDUPL_FRAME_INFO frameInfo;
            
            HRESULT hr = duplication->AcquireNextFrame(100, &frameInfo, &desktopResource);
            
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                continue;
            }
            
            if (SUCCEEDED(hr) && desktopResource) {
                ID3D11Texture2D* texture = nullptr;
                hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&texture);
                
                if (SUCCEEDED(hr) && texture) {
                    ProcessFrame(texture);
                    texture->Release();
                }
                
                desktopResource->Release();
                duplication->ReleaseFrame();
            } else if (hr == DXGI_ERROR_ACCESS_LOST) {
                OutputDebugStringA("DXGI_ERROR_ACCESS_LOST - need to reinitialize\n");
                break;
            }
            
            auto frameEnd = std::chrono::high_resolution_clock::now();
            auto frameDuration = std::chrono::duration_cast<std::chrono::milliseconds>(frameEnd - frameStart).count();
            if (frameDuration < frameInterval) {
                Sleep(frameInterval - frameDuration);
            }
        }
    }
    
    void ProcessFrame(ID3D11Texture2D* texture) {
        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);
        
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        
        ID3D11Texture2D* stagingTexture = nullptr;
        HRESULT hr = device->CreateTexture2D(&desc, nullptr, &stagingTexture);
        
        if (FAILED(hr) || !stagingTexture) return;
        
        context->CopyResource(stagingTexture, texture);
        
        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = context->Map(stagingTexture, 0, D3D11_MAP_READ, 0, &mapped);
        
        if (SUCCEEDED(hr)) {
            VideoFrameData* frameData = new VideoFrameData();
            frameData->width = targetWidth;
            frameData->height = targetHeight;
            frameData->timestamp = g_syncManager.GetVideoTimestamp();
            frameData->hasRealPixels = true;
            
            if (desc.Width != targetWidth || desc.Height != targetHeight) {
                frameData->dataSize = targetWidth * targetHeight * 4;
                frameData->data = new uint8_t[frameData->dataSize];
                
                float xRatio = (float)desc.Width / targetWidth;
                float yRatio = (float)desc.Height / targetHeight;
                
                uint8_t* src = (uint8_t*)mapped.pData;
                uint8_t* dst = frameData->data;
                
                for (int y = 0; y < targetHeight; y++) {
                    for (int x = 0; x < targetWidth; x++) {
                        int srcX = (int)(x * xRatio);
                        int srcY = (int)(y * yRatio);
                        int srcIdx = (srcY * mapped.RowPitch) + (srcX * 4);
                        int dstIdx = (y * targetWidth + x) * 4;
                        
                        memcpy(&dst[dstIdx], &src[srcIdx], 4);
                    }
                }
            } else {
                frameData->dataSize = desc.Width * desc.Height * 4;
                frameData->data = new uint8_t[frameData->dataSize];
                
                uint8_t* src = (uint8_t*)mapped.pData;
                uint8_t* dst = frameData->data;
                
                for (UINT y = 0; y < desc.Height; y++) {
                    memcpy(dst, src, desc.Width * 4);
                    src += mapped.RowPitch;
                    dst += desc.Width * 4;
                }
            }
            
            context->Unmap(stagingTexture, 0);
            
            g_video_frame_count++;
            
            if (g_video_tsfn) {
                napi_status status = napi_call_threadsafe_function(
                    g_video_tsfn,
                    frameData,
                    napi_tsfn_blocking
                );
                
                if (status != napi_ok) {
                    delete[] frameData->data;
                    delete frameData;
                }
            } else {
                delete[] frameData->data;
                delete frameData;
            }
        }
        
        stagingTexture->Release();
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

// УЛУЧШЕННЫЙ КЛАСС для захвата звука с умной фильтрацией и конференций
class ApplicationAudioCapture {
private:
    // Структура для хранения информации о сессии
    struct AudioSessionInfo {
        DWORD processId;
        std::wstring processName;
        bool shouldCapture;
        float currentVolume;
        IAudioSessionControl* control;
    };
    
    // Списки для фильтрации
    std::set<DWORD> excludedProcessIds;
    std::set<std::wstring> excludedProcessNames;
    std::map<DWORD, AudioSessionInfo> activeSessions;
    std::mutex sessionsMutex;
    
    DWORD currentElectronPid;
    DWORD targetProcessId = 0;  // ID процесса захватываемого окна
    std::wstring applicationName;
    
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    IAudioSessionManager2* sessionManager = nullptr;
    WAVEFORMATEX* waveFormat = nullptr;
    
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    std::thread monitorThread;
    std::vector<float> accumulationBuffer;
    std::mutex bufferMutex;
    const int TARGET_FRAME_SIZE = 960;
    
    LARGE_INTEGER performanceFrequency;
    LARGE_INTEGER captureStartTime;
    
    // Флаги режима работы
    std::atomic<bool> filterConferenceAudio{true};
    std::atomic<bool> isWindowCapture{false};  // true если захватываем конкретное окно

    void InitializeExclusions() {
        // Текущий процесс Electron
        currentElectronPid = GetCurrentProcessId();
        excludedProcessIds.insert(currentElectronPid);
        
        // Список процессов конференций для исключения
        // НЕ добавляем браузеры по умолчанию - они могут быть источником контента
        excludedProcessNames.insert(L"teams.exe");
        excludedProcessNames.insert(L"zoom.exe");
        excludedProcessNames.insert(L"zoomvideomeetings.exe");
        excludedProcessNames.insert(L"skype.exe");
        excludedProcessNames.insert(L"discord.exe");
        excludedProcessNames.insert(L"slack.exe");
        excludedProcessNames.insert(L"webex.exe");
        excludedProcessNames.insert(L"gotomeeting.exe");
        
        OutputDebugStringA("Audio exclusions initialized (smart mode)\n");
    }

    bool ShouldCaptureFromProcess(DWORD processId) {
        // ВАЖНО: Если захватываем конкретное окно - всегда берем его звук
        if (isWindowCapture && processId == targetProcessId) {
            char log[256];
            sprintf_s(log, "Capturing audio from target window process: %lu\n", processId);
            OutputDebugStringA(log);
            return true;  // Всегда захватываем звук целевого окна
        }
        
        // Если фильтрация отключена, захватываем все
        if (!filterConferenceAudio) {
            return true;
        }
        
        // Проверяем по ID процесса - исключаем текущий Electron
        if (processId == currentElectronPid) {
            OutputDebugStringA("Excluding current Electron process\n");
            return false;
        }
        
        // Дополнительные исключенные процессы
        if (excludedProcessIds.count(processId) > 0) {
            char log[256];
            sprintf_s(log, "Excluding process by ID: %lu\n", processId);
            OutputDebugStringA(log);
            return false;
        }
        
        // Получаем имя процесса
        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
        if (!hProcess) {
            return true; // Если не можем проверить, разрешаем
        }
        
        wchar_t exePath[MAX_PATH];
        DWORD pathLen = MAX_PATH;
        bool shouldCapture = true;
        
        if (QueryFullProcessImageNameW(hProcess, 0, exePath, &pathLen)) {
            std::wstring fullPath(exePath);
            
            // Извлекаем имя файла
            size_t lastSlash = fullPath.find_last_of(L"\\/");
            std::wstring fileName = (lastSlash != std::wstring::npos) 
                ? fullPath.substr(lastSlash + 1) 
                : fullPath;
            
            // Приводим к нижнему регистру для сравнения
            std::transform(fileName.begin(), fileName.end(), fileName.begin(), ::tolower);
            
            // Специальная логика для браузеров
            if (fileName == L"chrome.exe" || fileName == L"msedge.exe" || 
                fileName == L"firefox.exe" || fileName == L"opera.exe") {
                
                // Для системного захвата - проверяем, не Jitsi ли это
                if (!isWindowCapture) {
                    // Пытаемся определить по заголовкам окон
                    bool isConferenceTab = CheckIfBrowserHasConferenceTab(processId);
                    if (isConferenceTab) {
                        OutputDebugStringA("Detected conference tab in browser - excluding\n");
                        shouldCapture = false;
                    } else {
                        // Обычный браузер - захватываем
                        shouldCapture = true;
                    }
                } else {
                    // При захвате окна - всегда берем звук браузера
                    shouldCapture = true;
                }
            } else {
                // Проверяем по списку исключений для не-браузеров
                for (const auto& excluded : excludedProcessNames) {
                    std::wstring excludedLower = excluded;
                    std::transform(excludedLower.begin(), excludedLower.end(), 
                                 excludedLower.begin(), ::tolower);
                    
                    if (fileName == excludedLower || 
                        fileName.find(excludedLower) != std::wstring::npos) {
                        char log[512];
                        char fileNameChar[256] = {0};
                        wcstombs(fileNameChar, fileName.c_str(), sizeof(fileNameChar) - 1);
                        sprintf_s(log, "Excluding conference app: %s (PID: %lu)\n", 
                                fileNameChar, processId);
                        OutputDebugStringA(log);
                        shouldCapture = false;
                        break;
                    }
                }
            }
        }
        
        CloseHandle(hProcess);
        return shouldCapture;
    }
    
    bool CheckIfBrowserHasConferenceTab(DWORD processId) {
        // Эвристика для определения конференц-вкладок в браузере
        // Проверяем заголовки окон процесса
        bool hasConference = false;
        
        EnumWindows([](HWND hwnd, LPARAM lParam) -> BOOL {
            DWORD pid;
            GetWindowThreadProcessId(hwnd, &pid);
            
            auto* data = reinterpret_cast<std::pair<DWORD, bool*>*>(lParam);
            if (pid == data->first) {
                char title[256];
                GetWindowTextA(hwnd, title, sizeof(title));
                std::string windowTitle(title);
                std::transform(windowTitle.begin(), windowTitle.end(), 
                             windowTitle.begin(), ::tolower);
                
                // Проверяем типичные признаки конференций
                if (windowTitle.find("meet") != std::string::npos ||
                    windowTitle.find("zoom") != std::string::npos ||
                    windowTitle.find("teams") != std::string::npos ||
                    windowTitle.find("jitsi") != std::string::npos ||
                    windowTitle.find("webex") != std::string::npos ||
                    windowTitle.find("conference") != std::string::npos ||
                    windowTitle.find("call") != std::string::npos) {
                    *(data->second) = true;
                    return FALSE; // Прекращаем перечисление
                }
            }
            return TRUE;
        }, reinterpret_cast<LPARAM>(&std::make_pair(processId, &hasConference)));
        
        return hasConference;
    }
    
    void UpdateAudioSessions() {
        if (!sessionManager) return;
        
        std::lock_guard<std::mutex> lock(sessionsMutex);
        
        // Очищаем старые сессии
        for (auto& pair : activeSessions) {
            if (pair.second.control) {
                pair.second.control->Release();
            }
        }
        activeSessions.clear();
        
        IAudioSessionEnumerator* sessionEnumerator = nullptr;
        HRESULT hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
        if (FAILED(hr)) return;
        
        int sessionCount = 0;
        sessionEnumerator->GetCount(&sessionCount);
        
        for (int i = 0; i < sessionCount; i++) {
            IAudioSessionControl* sessionControl = nullptr;
            hr = sessionEnumerator->GetSession(i, &sessionControl);
            if (FAILED(hr)) continue;
            
            IAudioSessionControl2* sessionControl2 = nullptr;
            hr = sessionControl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&sessionControl2);
            
            if (SUCCEEDED(hr)) {
                DWORD processId = 0;
                hr = sessionControl2->GetProcessId(&processId);
                
                if (SUCCEEDED(hr) && processId != 0) {
                    AudioSessionInfo info;
                    info.processId = processId;
                    info.shouldCapture = ShouldCaptureFromProcess(processId);
                    info.control = sessionControl;
                    info.currentVolume = 0.0f;
                    
                    // Получаем состояние сессии
                    AudioSessionState state;
                    hr = sessionControl->GetState(&state);
                    
                    if (SUCCEEDED(hr) && state == AudioSessionStateActive) {
                        // Получаем уровень громкости
                        IAudioMeterInformation* meterInfo = nullptr;
                        hr = sessionControl->QueryInterface(__uuidof(IAudioMeterInformation), 
                                                           (void**)&meterInfo);
                        if (SUCCEEDED(hr)) {
                            float peakValue = 0.0f;
                            meterInfo->GetPeakValue(&peakValue);
                            info.currentVolume = peakValue;
                            meterInfo->Release();
                        }
                    }
                    
                    activeSessions[processId] = info;
                    sessionControl->AddRef(); // Увеличиваем счетчик ссылок
                }
                
                sessionControl2->Release();
            } else {
                sessionControl->Release();
            }
        }
        
        sessionEnumerator->Release();
        
        // Логирование активных сессий
        static int logCounter = 0;
        if (++logCounter % 50 == 0) { // Логируем каждые 50 обновлений
            char log[512];
            sprintf_s(log, "Audio sessions: Total=%zu, Filtered=%d, Mode=%s, Target=%lu\n", 
                    activeSessions.size(),
                    std::count_if(activeSessions.begin(), activeSessions.end(),
                                [](const auto& pair) { return !pair.second.shouldCapture; }),
                    isWindowCapture ? "WINDOW" : "SYSTEM",
                    targetProcessId);
            OutputDebugStringA(log);
        }
    }
    
public:
    bool InitializeForApplication(HWND hwnd) {
        CoInitialize(nullptr);
        InitializeExclusions();
        
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        
        // Получаем процесс целевого окна
        GetWindowThreadProcessId(hwnd, &targetProcessId);
        isWindowCapture = true;  // Устанавливаем режим захвата окна
        
        // При захвате конкретного окна НЕ фильтруем его звук
        filterConferenceAudio = true;  // Но фильтруем другие процессы
        
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
        
        char log[256];
        sprintf_s(log, "Window capture mode: PID=%lu, App=%ls\n", 
                targetProcessId, applicationName.c_str());
        OutputDebugStringA(log);
        
        HRESULT hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator),
            (void**)&deviceEnumerator
        );
        
        if (FAILED(hr)) return false;
        
        hr = deviceEnumerator->GetDefaultAudioEndpoint(
            eRender,
            eConsole,
            &device
        );
        
        if (FAILED(hr)) return false;
        
        hr = device->Activate(
            __uuidof(IAudioSessionManager2),
            CLSCTX_ALL,
            nullptr,
            (void**)&sessionManager
        );
        
        if (FAILED(hr)) return false;
        
        hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            (void**)&audioClient
        );
        
        if (FAILED(hr)) return false;
        
        hr = audioClient->GetMixFormat(&waveFormat);
        if (FAILED(hr)) return false;
        
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            20000000,
            0,
            waveFormat,
            nullptr
        );
        
        if (FAILED(hr)) return false;
        
        hr = audioClient->GetService(
            __uuidof(IAudioCaptureClient),
            (void**)&captureClient
        );
        
        if (SUCCEEDED(hr)) {
            OutputDebugStringA("Window audio capture initialized (smart filtering)\n");
        }
        
        return SUCCEEDED(hr);
    }

    bool InitializeForSystemAudio() {
        CoInitialize(nullptr);
        InitializeExclusions();
        
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        
        // Системный захват - нет целевого окна
        targetProcessId = 0;
        isWindowCapture = false;
        filterConferenceAudio = true;  // Включаем полную фильтрацию
        
        OutputDebugStringA("System audio mode: Full conference filtering enabled\n");
        
        HRESULT hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator),
            (void**)&deviceEnumerator
        );
        
        if (FAILED(hr)) return false;
        
        hr = deviceEnumerator->GetDefaultAudioEndpoint(
            eRender,
            eConsole,
            &device
        );
        
        if (FAILED(hr)) return false;
        
        hr = device->Activate(
            __uuidof(IAudioSessionManager2),
            CLSCTX_ALL,
            nullptr,
            (void**)&sessionManager
        );
        
        if (FAILED(hr)) return false;
        
        hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            (void**)&audioClient
        );
        
        if (FAILED(hr)) return false;
        
        hr = audioClient->GetMixFormat(&waveFormat);
        if (FAILED(hr)) return false;
        
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            20000000,
            0,
            waveFormat,
            nullptr
        );
        
        if (FAILED(hr)) return false;
        
        hr = audioClient->GetService(
            __uuidof(IAudioCaptureClient),
            (void**)&captureClient
        );
        
        OutputDebugStringA("System audio capture initialized with smart filtering\n");
        return SUCCEEDED(hr);
    }
    
    void SetFilterConferenceAudio(bool enable) {
        filterConferenceAudio = enable;
        char log[256];
        sprintf_s(log, "Conference audio filtering: %s (mode: %s)\n", 
                enable ? "ENABLED" : "DISABLED",
                isWindowCapture ? "WINDOW" : "SYSTEM");
        OutputDebugStringA(log);
    }
    
    void AddExcludedProcess(DWORD processId) {
        excludedProcessIds.insert(processId);
    }
    
    void RemoveExcludedProcess(DWORD processId) {
        excludedProcessIds.erase(processId);
    }
    
    void AddExcludedProcessName(const std::wstring& processName) {
        excludedProcessNames.insert(processName);
    }
    
    void RemoveExcludedProcessName(const std::wstring& processName) {
        excludedProcessNames.erase(processName);
    }
    
    void StartCapture() {
        if (!audioClient) return;
        
        isCapturing = true;
        
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.clear();
            accumulationBuffer.reserve(192000);
        }
        
        // Запускаем мониторинг сессий
        monitorThread = std::thread([this]() {
            CoInitialize(nullptr);
            while (isCapturing) {
                UpdateAudioSessions();
                Sleep(100); // Обновляем каждые 100мс
            }
            CoUninitialize();
        });
        
        HRESULT hr = audioClient->Start();
        
        if (SUCCEEDED(hr)) {
            captureThread = std::thread([this]() {
                CoInitialize(nullptr);
                CaptureLoop();
                CoUninitialize();
            });
            
            char log[256];
            sprintf_s(log, "Audio capture started (Mode: %s, Filter: %s)\n",
                    isWindowCapture ? "WINDOW" : "SYSTEM",
                    filterConferenceAudio ? "ON" : "OFF");
            OutputDebugStringA(log);
        }
    }
    
    void CaptureLoop() {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        
        while (isCapturing) {
            UINT32 packetLength = 0;
            HRESULT hr = captureClient->GetNextPacketSize(&packetLength);
            
            if (SUCCEEDED(hr) && packetLength > 0) {
                BYTE* data = nullptr;
                UINT32 numFramesAvailable;
                DWORD flags;
                
                hr = captureClient->GetBuffer(
                    &data,
                    &numFramesAvailable,
                    &flags,
                    nullptr,
                    nullptr
                );
                
                if (SUCCEEDED(hr)) {
                    if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && numFramesAvailable > 0) {
                        ProcessAudioData(data, numFramesAvailable);
                    }
                    
                    captureClient->ReleaseBuffer(numFramesAvailable);
                }
            } else {
                Sleep(2);
            }
        }
    }
    
    void ProcessAudioData(BYTE* data, UINT32 numFrames) {
        size_t sampleCount = numFrames * waveFormat->nChannels;
        std::vector<float> samples(sampleCount);
        
        // Конвертируем в float
        bool hasNonZero = false;
        
        if (waveFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
            float* srcFloat = (float*)data;
            for (size_t i = 0; i < sampleCount; i++) {
                samples[i] = srcFloat[i];
                if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_PCM) {
            if (waveFormat->wBitsPerSample == 16) {
                INT16* src = (INT16*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = src[i] / 32768.0f;
                    if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
                }
            } else if (waveFormat->wBitsPerSample == 32) {
                INT32* src = (INT32*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = src[i] / 2147483648.0f;
                    if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
                }
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            WAVEFORMATEXTENSIBLE* pWaveFormatExt = (WAVEFORMATEXTENSIBLE*)waveFormat;
            
            if (IsEqualGUID(pWaveFormatExt->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
                float* srcFloat = (float*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = srcFloat[i];
                    if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
                }
            } else if (IsEqualGUID(pWaveFormatExt->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
                if (waveFormat->wBitsPerSample == 16) {
                    INT16* src = (INT16*)data;
                    for (size_t i = 0; i < sampleCount; i++) {
                        samples[i] = src[i] / 32768.0f;
                        if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
                    }
                } else if (waveFormat->wBitsPerSample == 32) {
                    INT32* src = (INT32*)data;
                    for (size_t i = 0; i < sampleCount; i++) {
                        samples[i] = src[i] / 2147483648.0f;
                        if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
                    }
                } else if (waveFormat->wBitsPerSample == 24) {
                    for (size_t i = 0; i < sampleCount; i++) {
                        BYTE* samplePtr = data + (i * 3);
                        INT32 sample = (samplePtr[0] | (samplePtr[1] << 8) | (samplePtr[2] << 16));
                        if (sample & 0x800000) sample |= 0xFF000000;
                        samples[i] = sample / 8388608.0f;
                        if (fabs(samples[i]) > 0.0001f) hasNonZero = true;
                    }
                }
            }
        }
        
        // ПРИМЕНЯЕМ ФИЛЬТРАЦИЮ только если включена
        if (filterConferenceAudio) {
            ApplySessionBasedFiltering(samples);
        }
        
        // Добавляем в буфер
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.insert(accumulationBuffer.end(), 
                                    samples.begin(), samples.end());
        }
        
        SendBufferedFrames();
    }
    
    void ApplySessionBasedFiltering(std::vector<float>& samples) {
        std::lock_guard<std::mutex> lock(sessionsMutex);
        
        // Подсчитываем сколько сессий исключено
        int excludedCount = 0;
        float totalExcludedVolume = 0.0f;
        
        for (const auto& pair : activeSessions) {
            if (!pair.second.shouldCapture) {
                excludedCount++;
                totalExcludedVolume += pair.second.currentVolume;
            }
        }
        
        // Если есть исключенные сессии с активным звуком, приглушаем общий сигнал
        if (excludedCount > 0 && totalExcludedVolume > 0.01f) {
            // Применяем адаптивное подавление
            float suppressionFactor = 1.0f - (totalExcludedVolume * 0.8f);
            suppressionFactor = (std::max)(0.1f, suppressionFactor); // Минимум 10% от оригинала
            
            for (auto& sample : samples) {
                sample *= suppressionFactor;
            }
            
            static int logCounter = 0;
            if (++logCounter % 100 == 0) {
                char log[256];
                sprintf_s(log, "Filtering: Excluded %d sessions, suppression: %.2f\n",
                        excludedCount, suppressionFactor);
                OutputDebugStringA(log);
            }
        }
    }
    
    void SendBufferedFrames() {
        while (true) {
            std::unique_lock<std::mutex> lock(bufferMutex);
            
            size_t samplesPerChannel = accumulationBuffer.size() / waveFormat->nChannels;
            if (samplesPerChannel < TARGET_FRAME_SIZE) {
                break;
            }
            
            AudioFrameData* frameData = new AudioFrameData();
            frameData->numSamples = TARGET_FRAME_SIZE;
            frameData->sampleRate = waveFormat->nSamplesPerSec;
            frameData->channels = waveFormat->nChannels;
            frameData->timestamp = g_syncManager.GetAudioTimestamp();
            frameData->isSystemAudio = !isWindowCapture;
            
            if (!applicationName.empty()) {
                char appName[256] = {0};
                wcstombs(appName, applicationName.c_str(), sizeof(appName) - 1);
                frameData->applicationName = appName;
            }
            
            size_t frameSampleCount = TARGET_FRAME_SIZE * waveFormat->nChannels;
            frameData->samples = new float[frameSampleCount];
            
            std::copy(accumulationBuffer.begin(), 
                    accumulationBuffer.begin() + frameSampleCount,
                    frameData->samples);
            
            accumulationBuffer.erase(accumulationBuffer.begin(), 
                                accumulationBuffer.begin() + frameSampleCount);
            
            lock.unlock();
            
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
        }
    }
    
    void StopCapture() {
        isCapturing = false;
        
        if (audioClient) {
            audioClient->Stop();
        }
        
        if (monitorThread.joinable()) {
            monitorThread.join();
        }
        
        if (captureThread.joinable()) {
            captureThread.join();
        }
        
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.clear();
        }
        
        {
            std::lock_guard<std::mutex> lock(sessionsMutex);
            for (auto& pair : activeSessions) {
                if (pair.second.control) {
                    pair.second.control->Release();
                }
            }
            activeSessions.clear();
        }
        
        OutputDebugStringA("Audio capture stopped\n");
    }
    
    ~ApplicationAudioCapture() {
        StopCapture();
        
        if (sessionManager) sessionManager->Release();
        if (captureClient) captureClient->Release();
        if (audioClient) audioClient->Release();
        if (device) device->Release();
        if (deviceEnumerator) deviceEnumerator->Release();
        if (waveFormat) CoTaskMemFree(waveFormat);
        
        CoUninitialize();
    }
};

// Глобальные экземпляры захвата
static std::unique_ptr<DXGIScreenCapture> g_screenCapture;
static std::unique_ptr<ApplicationAudioCapture> g_appAudioCapture;
static CaptureSource g_currentSource;

// === N-API функции ===

napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, "Windows Native Module v2.0 - Conference Audio Filtering", NAPI_AUTO_LENGTH, &result);
    return result;
}

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

// Получение доступных источников
napi_value GetAvailableSources(napi_env env, napi_callback_info info) {
    napi_value array;
    napi_create_array(env, &array);
    
    std::vector<CaptureSource> sources;
    
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
    
    EnumWindowsData enumData;
    enumData.sources = &sources;
    EnumWindows(EnumWindowsProc, (LPARAM)&enumData);
    
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

// Установка источника захвата
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

// Установка качества захвата
napi_value SetCaptureQuality(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected quality object");
        return nullptr;
    }
    
    napi_value widthVal, heightVal, fpsVal;
    napi_get_named_property(env, argv[0], "width", &widthVal);
    napi_get_named_property(env, argv[0], "height", &heightVal);
    napi_get_named_property(env, argv[0], "fps", &fpsVal);
    
    int width = 1920, height = 1080, fps = 30;
    napi_get_value_int32(env, widthVal, &width);
    napi_get_value_int32(env, heightVal, &height);
    napi_get_value_int32(env, fpsVal, &fps);
    
    {
        std::lock_guard<std::mutex> lock(g_quality.mutex);
        g_quality.width = width;
        g_quality.height = height;
        g_quality.fps = fps;
    }
    
    if (g_screenCapture) {
        g_screenCapture->SetQuality(width, height, fps);
    }
    
    napi_value result;
    napi_create_object(env, &result);
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// НОВАЯ ФУНКЦИЯ: Установка фильтрации аудио
napi_value SetAudioFilter(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected filter settings object");
        return nullptr;
    }
    
    // Получаем параметры фильтрации
    napi_value filterConferenceVal;
    napi_get_named_property(env, argv[0], "filterConferenceAudio", &filterConferenceVal);
    
    bool filterConference = true;
    napi_get_value_bool(env, filterConferenceVal, &filterConference);
    
    // Применяем настройки
    if (g_appAudioCapture) {
        g_appAudioCapture->SetFilterConferenceAudio(filterConference);
    }
    
    // Обработка дополнительных исключений
    napi_value excludeProcessesVal;
    if (napi_get_named_property(env, argv[0], "excludeProcesses", &excludeProcessesVal) == napi_ok) {
        uint32_t arrayLength;
        napi_get_array_length(env, excludeProcessesVal, &arrayLength);
        
        for (uint32_t i = 0; i < arrayLength; i++) {
            napi_value element;
            napi_get_element(env, excludeProcessesVal, i, &element);
            
            char processName[256];
            size_t length;
            napi_get_value_string_utf8(env, element, processName, sizeof(processName), &length);
            
            if (g_appAudioCapture) {
                std::wstring wProcessName(processName, processName + length);
                g_appAudioCapture->AddExcludedProcessName(wProcessName);
            }
        }
    }
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    napi_value message;
    std::string msg = filterConference ? "Conference audio filtering enabled" : "Conference audio filtering disabled";
    napi_create_string_utf8(env, msg.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_set_named_property(env, result, "message", message);
    
    return result;
}

// Начало захвата
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
    
    // Запускаем аудио захват с фильтрацией
    if (g_currentSource.type == "window") {
        try {
            HWND hwnd = (HWND)std::stoull(g_currentSource.id);
            
            if (IsWindow(hwnd)) {
                g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
                
                if (g_appAudioCapture->InitializeForApplication(hwnd)) {
                    g_appAudioCapture->StartCapture();
                    audioStarted = true;
                    OutputDebugStringA("Started application audio capture with filtering\n");
                } else {
                    if (g_appAudioCapture->InitializeForSystemAudio()) {
                        g_appAudioCapture->StartCapture();
                        audioStarted = true;
                        OutputDebugStringA("Fallback to system audio capture with filtering\n");
                    }
                }
            }
        } catch (...) {
            OutputDebugStringA("Exception in window audio capture\n");
        }
    } else {
        g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
        if (g_appAudioCapture->InitializeForSystemAudio()) {
            g_appAudioCapture->StartCapture();
            audioStarted = true;
            OutputDebugStringA("Started system audio capture with filtering\n");
        }
    }
    
    g_capture_active = videoStarted || audioStarted;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, videoStarted || audioStarted, &success);
    napi_set_named_property(env, result, "success", success);
    
    napi_value message;
    std::string msg = "Started: ";
    if (videoStarted) msg += "video ";
    if (audioStarted) msg += "audio (with conference filtering)";
    napi_create_string_utf8(env, msg.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_set_named_property(env, result, "message", message);
    
    return result;
}

// Остановка захвата
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

// Установка callback для видео
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

// Установка callback для аудио
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
    napi_create_string_utf8(env, "WebRTC audio callback set", NAPI_AUTO_LENGTH, &result);
    return result;
}

// Инициализация модуля
napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"testMethod", nullptr, TestMethod, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getAvailableSources", nullptr, GetAvailableSources, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startCapture", nullptr, StartCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopCapture", nullptr, StopCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setCaptureQuality", nullptr, SetCaptureQuality, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setCaptureSource", nullptr, SetCaptureSource, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setAudioFilter", nullptr, SetAudioFilter, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCVideoCallback", nullptr, SetWebRTCVideoCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCAudioCallback", nullptr, SetWebRTCAudioCallback, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)