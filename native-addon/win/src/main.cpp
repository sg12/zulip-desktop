#define NOMINMAX
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
#include <algorithm>
#include <string>
#include <chrono>
#include <mutex>
#include <cstring>
#include <cmath>

#include <ks.h>
#include <ksmedia.h>
#include <functiondiscoverykeys_devpkey.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "psapi.lib")

// ============================================================================
// ОПРЕДЕЛЕНИЯ ДЛЯ PROCESS LOOPBACK API
// ============================================================================
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

// Всегда определяем структуры для Process Loopback API
// Это гарантирует совместимость на любой системе сборки
#ifndef AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK

typedef enum _AUDIOCLIENT_ACTIVATION_TYPE {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef enum _PROCESS_LOOPBACK_MODE {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    } DUMMYUNIONNAME;
} AUDIOCLIENT_ACTIVATION_PARAMS;

#endif // !AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK

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

// Глобальная переменная для управления громкостью
static std::atomic<float> g_participants_volume{0.20f};
static std::mutex g_volume_mutex;

// Флаг доступности Process Loopback
static std::atomic<bool> g_process_loopback_available{false};

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

// ============================================================================
// КЛАСС ДЛЯ АСИНХРОННОЙ АКТИВАЦИИ (если доступен API)
// ============================================================================
class ProcessLoopbackActivationHandler : public IActivateAudioInterfaceCompletionHandler {
private:
    LONG refCount = 1;
    IAudioClient** targetClient;
    HANDLE completionEvent;
    HRESULT activationResult = E_FAIL;
    
public:
    ProcessLoopbackActivationHandler(IAudioClient** client) : targetClient(client) {
        completionEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    }
    
    // IUnknown methods
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = this;
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    
    STDMETHODIMP_(ULONG) AddRef() {
        return InterlockedIncrement(&refCount);
    }
    
    STDMETHODIMP_(ULONG) Release() {
        LONG count = InterlockedDecrement(&refCount);
        if (count == 0) {
            delete this;
        }
        return count;
    }
    
    // IActivateAudioInterfaceCompletionHandler method
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) {
        HRESULT hrActivate = E_FAIL;
        IUnknown* unknown = nullptr;
        
        HRESULT hr = operation->GetActivateResult(&hrActivate, &unknown);
        
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && unknown != nullptr) {
            hr = unknown->QueryInterface(IID_PPV_ARGS(targetClient));
            unknown->Release();
            activationResult = hr;
        } else {
            activationResult = FAILED(hr) ? hr : hrActivate;
        }
        
        SetEvent(completionEvent);
        return S_OK;
    }
    
    HRESULT Wait(DWORD timeout = 5000) {
        DWORD result = WaitForSingleObject(completionEvent, timeout);
        CloseHandle(completionEvent);
        
        if (result == WAIT_TIMEOUT) {
            return E_FAIL;
        }
        
        return activationResult;
    }
};

// ============================================================================
// ПРОВЕРКА ДОСТУПНОСТИ PROCESS LOOPBACK API
// ============================================================================
bool CheckProcessLoopbackSupport() {
    // Проверяем версию Windows
    OSVERSIONINFOEXW osvi = { sizeof(osvi), 0, 0, 0, 0, {0}, 0, 0 };
    DWORDLONG const dwlConditionMask = VerSetConditionMask(
        VerSetConditionMask(
            VerSetConditionMask(0, VER_MAJORVERSION, VER_GREATER_EQUAL),
            VER_MINORVERSION, VER_GREATER_EQUAL),
        VER_BUILDNUMBER, VER_GREATER_EQUAL);
    
    osvi.dwMajorVersion = 10;
    osvi.dwMinorVersion = 0;
    osvi.dwBuildNumber = 20348; // Минимальная версия для Process Loopback
    
    if (VerifyVersionInfoW(&osvi, VER_MAJORVERSION | VER_MINORVERSION | VER_BUILDNUMBER, dwlConditionMask)) {
        OutputDebugStringA("Process Loopback API potentially available (Windows version check passed)\n");
        return true;
    }
    
    OutputDebugStringA("Process Loopback API not available (Windows version too old)\n");
    return false;
}

// Класс для управления громкостью других приложений
class VolumeController {
private:
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioSessionManager2* sessionManager = nullptr;
    DWORD currentProcessId = 0;
    std::thread volumeThread;
    std::atomic<bool> isRunning{false};
    
public:
    bool Initialize() {
        currentProcessId = GetCurrentProcessId();
        
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
        
        return SUCCEEDED(hr);
    }
    
    void StartVolumeControl() {
        if (isRunning) return;
        
        isRunning = true;
        volumeThread = std::thread([this]() {
            CoInitialize(nullptr);
            
            while (isRunning) {
                UpdateVolumes();
                Sleep(100);
            }
            
            CoUninitialize();
        });
    }
    
    void UpdateVolumes() {
        if (!sessionManager) return;
        
        IAudioSessionEnumerator* sessionEnumerator = nullptr;
        HRESULT hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
        if (FAILED(hr)) return;
        
        int sessionCount = 0;
        sessionEnumerator->GetCount(&sessionCount);
        
        float targetVolume = g_participants_volume.load();
        
        for (int i = 0; i < sessionCount; i++) {
            IAudioSessionControl* sessionControl = nullptr;
            hr = sessionEnumerator->GetSession(i, &sessionControl);
            if (FAILED(hr)) continue;
            
            IAudioSessionControl2* sessionControl2 = nullptr;
            hr = sessionControl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&sessionControl2);
            
            if (SUCCEEDED(hr)) {
                DWORD processId = 0;
                hr = sessionControl2->GetProcessId(&processId);
                
                if (SUCCEEDED(hr) && processId != currentProcessId && processId != 0) {
                    
                    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
                    if (hProcess) {
                        wchar_t exePath[MAX_PATH];
                        DWORD pathLen = MAX_PATH;
                        if (QueryFullProcessImageNameW(hProcess, 0, exePath, &pathLen)) {
                            std::wstring fullPath(exePath);
                            
                            if (fullPath.find(L"chrome.exe") != std::wstring::npos ||
                                fullPath.find(L"firefox.exe") != std::wstring::npos ||
                                fullPath.find(L"msedge.exe") != std::wstring::npos ||
                                fullPath.find(L"teams.exe") != std::wstring::npos ||
                                fullPath.find(L"zoom.exe") != std::wstring::npos) {
                                
                                ISimpleAudioVolume* simpleVolume = nullptr;
                                hr = sessionControl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&simpleVolume);
                                
                                if (SUCCEEDED(hr)) {
                                    simpleVolume->SetMasterVolume(targetVolume, nullptr);
                                    simpleVolume->Release();
                                }
                            }
                        }
                        CloseHandle(hProcess);
                    }
                }
                
                sessionControl2->Release();
            }
            
            sessionControl->Release();
        }
        
        sessionEnumerator->Release();
    }
    
    void StopVolumeControl() {
        isRunning = false;
        if (volumeThread.joinable()) {
            volumeThread.join();
        }
        
        if (sessionManager) {
            RestoreVolumes();
        }
    }
    
    void RestoreVolumes() {
        IAudioSessionEnumerator* sessionEnumerator = nullptr;
        HRESULT hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
        if (FAILED(hr)) return;
        
        int sessionCount = 0;
        sessionEnumerator->GetCount(&sessionCount);
        
        for (int i = 0; i < sessionCount; i++) {
            IAudioSessionControl* sessionControl = nullptr;
            hr = sessionEnumerator->GetSession(i, &sessionControl);
            if (FAILED(hr)) continue;
            
            ISimpleAudioVolume* simpleVolume = nullptr;
            hr = sessionControl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&simpleVolume);
            
            if (SUCCEEDED(hr)) {
                simpleVolume->SetMasterVolume(1.0f, nullptr);
                simpleVolume->Release();
            }
            
            sessionControl->Release();
        }
        
        sessionEnumerator->Release();
    }
    
    ~VolumeController() {
        StopVolumeControl();
        
        if (sessionManager) sessionManager->Release();
        if (device) device->Release();
        if (deviceEnumerator) deviceEnumerator->Release();
    }
};

static std::unique_ptr<VolumeController> g_volumeController;

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
    
public:
    bool Initialize(int displayId) {
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
            
            frameData->dataSize = targetWidth * targetHeight * 4;
            frameData->data = new uint8_t[frameData->dataSize];
            
            // Простое копирование или ресайз
            if (desc.Width == targetWidth && desc.Height == targetHeight) {
                uint8_t* src = (uint8_t*)mapped.pData;
                uint8_t* dst = frameData->data;
                
                for (UINT y = 0; y < desc.Height; y++) {
                    memcpy(dst, src, desc.Width * 4);
                    src += mapped.RowPitch;
                    dst += desc.Width * 4;
                }
            } else {
                // Простой ресайз
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
            }
            
            context->Unmap(stagingTexture, 0);
            
            g_video_frame_count++;
            
            if (g_video_tsfn) {
                napi_call_threadsafe_function(
                    g_video_tsfn,
                    frameData,
                    napi_tsfn_blocking
                );
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

// ============================================================================
// КЛАСС ДЛЯ ЗАХВАТА ЗВУКА
// ============================================================================
class ApplicationAudioCapture {
private:
    DWORD targetProcessId = 0;
    std::wstring applicationName;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    WAVEFORMATEX* waveFormat = nullptr;
    
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    std::vector<float> accumulationBuffer;
    std::mutex bufferMutex;
    const int TARGET_FRAME_SIZE = 960;
    
    bool useProcessLoopback = false;
    bool excludeMode = false;
    
public:
    // Попытка использовать Process Loopback API (если доступен)
    bool TryProcessLoopback(DWORD processId, bool exclude) {
        if (!g_process_loopback_available) {
            OutputDebugStringA("Process Loopback not available, skipping\n");
            return false;
        }
        
        // Проверяем, что у нас есть функция ActivateAudioInterfaceAsync
        HMODULE mmdevapi = GetModuleHandleW(L"mmdevapi.dll");
        if (!mmdevapi) {
            mmdevapi = LoadLibraryW(L"mmdevapi.dll");
        }
        
        if (!mmdevapi) {
            OutputDebugStringA("Cannot load mmdevapi.dll\n");
            return false;
        }
        
        typedef HRESULT (WINAPI *ActivateAudioInterfaceAsyncFunc)(
            LPCWSTR deviceInterfacePath,
            REFIID riid,
            PROPVARIANT *activationParams,
            IActivateAudioInterfaceCompletionHandler *completionHandler,
            IActivateAudioInterfaceAsyncOperation **activationOperation
        );
        
        auto ActivateAudioInterfaceAsync = (ActivateAudioInterfaceAsyncFunc)GetProcAddress(
            mmdevapi, "ActivateAudioInterfaceAsync");
        
        if (!ActivateAudioInterfaceAsync) {
            OutputDebugStringA("ActivateAudioInterfaceAsync not found\n");
            return false;
        }
        
        // Создаем PROPVARIANT с параметрами активации
        PROPVARIANT activateParams;
        PropVariantInit(&activateParams);
        
        // Создаем структуру параметров
        AUDIOCLIENT_ACTIVATION_PARAMS params = {};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = processId;
        params.ProcessLoopbackParams.ProcessLoopbackMode = exclude ? 
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE :
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        
        // Упаковываем в PROPVARIANT
        activateParams.vt = VT_BLOB;
        activateParams.blob.cbSize = sizeof(params);
        activateParams.blob.pBlobData = (BYTE*)&params;
        
        // Создаем обработчик
        ProcessLoopbackActivationHandler* handler = new ProcessLoopbackActivationHandler(&audioClient);
        IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
        
        // Вызываем активацию
        HRESULT hr = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient),
            &activateParams,
            handler,
            &asyncOp
        );
        
        if (SUCCEEDED(hr)) {
            hr = handler->Wait(5000);
            
            if (SUCCEEDED(hr) && audioClient) {
                // Используем фиксированный формат
                waveFormat = (WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
                waveFormat->wFormatTag = WAVE_FORMAT_PCM;
                waveFormat->nChannels = 2;
                waveFormat->nSamplesPerSec = 44100;
                waveFormat->wBitsPerSample = 16;
                waveFormat->nBlockAlign = (waveFormat->nChannels * waveFormat->wBitsPerSample) / 8;
                waveFormat->nAvgBytesPerSec = waveFormat->nSamplesPerSec * waveFormat->nBlockAlign;
                waveFormat->cbSize = 0;
                
                hr = audioClient->Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    0,  // Без LOOPBACK флага
                    20000000,
                    0,
                    waveFormat,
                    nullptr
                );
                
                if (SUCCEEDED(hr)) {
                    hr = audioClient->GetService(
                        __uuidof(IAudioCaptureClient),
                        (void**)&captureClient
                    );
                    
                    if (SUCCEEDED(hr)) {
                        useProcessLoopback = true;
                        excludeMode = exclude;
                        OutputDebugStringA("Process Loopback initialized successfully!\n");
                    }
                }
            }
        }
        
        handler->Release();
        if (asyncOp) asyncOp->Release();
        
        PropVariantClear(&activateParams);
        
        return SUCCEEDED(hr) && audioClient != nullptr;
    }
    
    // Захват звука конкретного приложения
    bool InitializeForApplication(HWND hwnd) {
        CoInitialize(nullptr);
        
        GetWindowThreadProcessId(hwnd, &targetProcessId);
        
        // Получаем имя приложения
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
        sprintf_s(log, "Initializing audio capture for PID: %lu\n", targetProcessId);
        OutputDebugStringA(log);
        
        // Сначала пробуем Process Loopback (если доступен)
        if (TryProcessLoopback(targetProcessId, false)) {
            return true;
        }
        
        // Если Process Loopback не удался, используем обычный системный захват
        OutputDebugStringA("Falling back to system audio capture\n");
        return InitializeForSystemAudio();
    }
    
    // Захват всего звука КРОМЕ текущего процесса
    bool InitializeExcludingCurrentProcess() {
        CoInitialize(nullptr);
        
        DWORD currentProcessId = GetCurrentProcessId();
        
        char log[256];
        sprintf_s(log, "Initializing audio capture EXCLUDING PID: %lu\n", currentProcessId);
        OutputDebugStringA(log);
        
        // Пробуем Process Loopback в режиме исключения
        if (TryProcessLoopback(currentProcessId, true)) {
            return true;
        }
        
        // Fallback к обычному системному захвату
        OutputDebugStringA("Falling back to system audio capture\n");
        return InitializeForSystemAudio();
    }
    
    // Обычный системный захват
    bool InitializeForSystemAudio() {
        CoInitialize(nullptr);
        
        IMMDeviceEnumerator* deviceEnumerator = nullptr;
        IMMDevice* device = nullptr;
        
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
        
        if (FAILED(hr)) {
            deviceEnumerator->Release();
            return false;
        }
        
        hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            (void**)&audioClient
        );
        
        device->Release();
        deviceEnumerator->Release();
        
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
        
        useProcessLoopback = false;
        return SUCCEEDED(hr);
    }
    
    void StartCapture() {
        if (!audioClient) return;
        
        isCapturing = true;
        
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.clear();
            accumulationBuffer.reserve(192000);
        }
        
        HRESULT hr = audioClient->Start();
        
        if (SUCCEEDED(hr)) {
            captureThread = std::thread([this]() {
                CoInitialize(nullptr);
                CaptureLoop();
                CoUninitialize();
            });
            
            const char* mode = useProcessLoopback ? 
                (excludeMode ? "Process Loopback (exclude)" : "Process Loopback (include)") : 
                "System loopback";
            char log[256];
            sprintf_s(log, "Audio capture started: %s\n", mode);
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
        
        // Конвертация в float
        if (waveFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
            float* srcFloat = (float*)data;
            for (size_t i = 0; i < sampleCount; i++) {
                samples[i] = srcFloat[i];
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_PCM) {
            if (waveFormat->wBitsPerSample == 16) {
                INT16* src = (INT16*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = src[i] / 32768.0f;
                }
            } else if (waveFormat->wBitsPerSample == 32) {
                INT32* src = (INT32*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = src[i] / 2147483648.0f;
                }
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            WAVEFORMATEXTENSIBLE* pWaveFormatExt = (WAVEFORMATEXTENSIBLE*)waveFormat;
            
            if (IsEqualGUID(pWaveFormatExt->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
                float* srcFloat = (float*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = srcFloat[i];
                }
            } else if (IsEqualGUID(pWaveFormatExt->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
                if (waveFormat->wBitsPerSample == 16) {
                    INT16* src = (INT16*)data;
                    for (size_t i = 0; i < sampleCount; i++) {
                        samples[i] = src[i] / 32768.0f;
                    }
                } else if (waveFormat->wBitsPerSample == 32) {
                    INT32* src = (INT32*)data;
                    for (size_t i = 0; i < sampleCount; i++) {
                        samples[i] = src[i] / 2147483648.0f;
                    }
                }
            }
        }
        
        // Добавляем в буфер
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.insert(accumulationBuffer.end(), 
                                    samples.begin(), samples.end());
        }
        
        SendBufferedFrames();
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
            frameData->isSystemAudio = !useProcessLoopback;
            
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
        
        if (captureThread.joinable()) {
            captureThread.join();
        }
        
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.clear();
        }
    }
    
    ~ApplicationAudioCapture() {
        StopCapture();
        
        if (captureClient) captureClient->Release();
        if (audioClient) audioClient->Release();
        if (waveFormat) CoTaskMemFree(waveFormat);
        
        CoUninitialize();
    }
};

// Глобальные экземпляры захвата
static std::unique_ptr<DXGIScreenCapture> g_screenCapture;
static std::unique_ptr<ApplicationAudioCapture> g_appAudioCapture;
static CaptureSource g_currentSource;

// === N-API функции ===

// Callback функция для перечисления окон
BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    if (!IsWindowVisible(hwnd)) return TRUE;
    
    char windowTitle[256];
    GetWindowTextA(hwnd, windowTitle, sizeof(windowTitle));
    
    if (strlen(windowTitle) == 0) return TRUE;
    
    DWORD style = GetWindowLong(hwnd, GWL_STYLE);
    DWORD exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
    
    if ((style & WS_CHILD) || (exStyle & WS_EX_TOOLWINDOW)) return TRUE;
    
    RECT rect;
    GetWindowRect(hwnd, &rect);
    int width = rect.right - rect.left;
    int height = rect.bottom - rect.top;
    
    if (width < 100 || height < 100) return TRUE;
    
    DWORD cloaked = 0;
    DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (cloaked != 0) return TRUE;
    
    auto* data = (EnumWindowsData*)lParam;
    
    CaptureSource source;
    source.type = "window";
    source.id = std::to_string((intptr_t)hwnd);
    source.name = std::string(windowTitle);
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
    
    // Добавляем экраны
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
                source.name = "Display " + std::to_string(outputIndex + 1);
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
    
    // Добавляем окна
    EnumWindowsData enumData;
    enumData.sources = &sources;
    EnumWindows(EnumWindowsProc, (LPARAM)&enumData);
    
    // Создаем JavaScript массив
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
    
    if (argc >= 1) {
        napi_value widthVal, heightVal, fpsVal;
        napi_get_named_property(env, argv[0], "width", &widthVal);
        napi_get_named_property(env, argv[0], "height", &heightVal);
        napi_get_named_property(env, argv[0], "fps", &fpsVal);
        
        int32_t width, height, fps;
        napi_get_value_int32(env, widthVal, &width);
        napi_get_value_int32(env, heightVal, &height);
        napi_get_value_int32(env, fpsVal, &fps);
        
        std::lock_guard<std::mutex> lock(g_quality.mutex);
        g_quality.width = width;
        g_quality.height = height;
        g_quality.fps = fps;
    }
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// Начало захвата
napi_value StartCapture(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    // ИЗМЕНЕНИЕ: excludeCurrentProcess теперь TRUE по умолчанию
    bool excludeCurrentProcess = true;  // ← БЫЛО false, СТАЛО true
    
    if (argc >= 1) {
        napi_value excludeVal;
        napi_get_named_property(env, argv[0], "excludeCurrentProcess", &excludeVal);
        
        // Проверяем, был ли явно передан параметр
        napi_valuetype valueType;
        napi_typeof(env, excludeVal, &valueType);
        
        // Если параметр передан явно - используем его значение
        if (valueType == napi_boolean) {
            napi_get_value_bool(env, excludeVal, &excludeCurrentProcess);
        }
        // Иначе оставляем true по умолчанию
    }
    
    // Проверяем поддержку Process Loopback при первом запуске
    static bool firstRun = true;
    if (firstRun) {
        g_process_loopback_available = CheckProcessLoopbackSupport();
        firstRun = false;
    }
    
    // Логирование режима захвата
    char modeLog[256];
    if (excludeCurrentProcess) {
        sprintf_s(modeLog, "Starting capture with EXCLUDE mode (echo cancellation enabled by default)\n");
    } else {
        sprintf_s(modeLog, "Starting capture with INCLUDE mode (all system audio)\n");
    }
    OutputDebugStringA(modeLog);
    
    g_syncManager.Initialize();
    g_syncManager.Reset();
    
    // Запускаем контроллер громкости
    if (!g_volumeController) {
        CoInitialize(nullptr);
        g_volumeController = std::make_unique<VolumeController>();
        if (g_volumeController->Initialize()) {
            g_volumeController->StartVolumeControl();
        }
    }
    
    // Останавливаем предыдущий захват
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
    
    // Запуск видео захвата
    if (g_currentSource.type == "screen") {
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
    
    // Запуск аудио захвата
    if (g_currentSource.type == "window") {
        // Захват аудио от конкретного окна
        try {
            HWND hwnd = (HWND)std::stoull(g_currentSource.id);
            
            if (IsWindow(hwnd)) {
                g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
                
                if (g_appAudioCapture->InitializeForApplication(hwnd)) {
                    g_appAudioCapture->StartCapture();
                    audioStarted = true;
                }
            }
        } catch (...) {
            OutputDebugStringA("Exception in window audio capture\n");
        }
    } else if (excludeCurrentProcess) {
        // Захват всего звука КРОМЕ текущего процесса
        g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
        if (g_appAudioCapture->InitializeExcludingCurrentProcess()) {
            g_appAudioCapture->StartCapture();
            audioStarted = true;
        }
    } else {
        // Обычный системный захват
        g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
        if (g_appAudioCapture->InitializeForSystemAudio()) {
            g_appAudioCapture->StartCapture();
            audioStarted = true;
        }
    }
    
    g_capture_active = videoStarted || audioStarted;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, videoStarted || audioStarted, &success);
    napi_set_named_property(env, result, "success", success);
    
    // Добавляем информацию о поддержке Process Loopback
    napi_value processLoopbackAvailable;
    napi_get_boolean(env, g_process_loopback_available.load(), &processLoopbackAvailable);
    napi_set_named_property(env, result, "processLoopbackAvailable", processLoopbackAvailable);
    
    napi_value message;
    std::string msg = "Started: ";
    if (videoStarted) msg += "video ";
    if (audioStarted) msg += "audio";
    if (g_process_loopback_available) msg += " (Process Loopback available)";
    napi_create_string_utf8(env, msg.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_set_named_property(env, result, "message", message);
    
    return result;
}

// Остановка захвата
napi_value StopCapture(napi_env env, napi_callback_info info) {
    g_capture_active = false;
    
    if (g_volumeController) {
        g_volumeController->StopVolumeControl();
        g_volumeController.reset();
    }
    
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
            napi_call_function(env, global, js_callback, 1, &videoInfo, &result);
            
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
            }
            
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_call_function(env, global, js_callback, 1, &audioInfo, &result);
            
            delete[] frameData->samples;
            delete frameData;
        },
        &g_audio_tsfn
    );
    
    napi_value result;
    napi_create_string_utf8(env, "WebRTC audio callback set", NAPI_AUTO_LENGTH, &result);
    return result;
}

// Установка громкости участников
napi_value SetParticipantsVolume(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    float volume = 0.20f;
    
    if (argc >= 1) {
        double inputVolume;
        napi_get_value_double(env, argv[0], &inputVolume);
        volume = (float)std::max(0.0, std::min(1.0, inputVolume));
    }
    
    g_participants_volume = volume;
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success, volumeSet;
    napi_get_boolean(env, true, &success);
    napi_create_double(env, volume, &volumeSet);
    
    napi_set_named_property(env, result, "success", success);
    napi_set_named_property(env, result, "volume", volumeSet);
    
    return result;
}

// Получение громкости участников
napi_value GetParticipantsVolume(napi_env env, napi_callback_info info) {
    float currentVolume = g_participants_volume.load();
    
    napi_value result;
    napi_create_double(env, currentVolume, &result);
    
    return result;
}

// Тестовый метод
napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    const char* message = g_process_loopback_available ? 
        "Windows Native Module v2.0 - Process Loopback AVAILABLE" :
        "Windows Native Module v2.0 - Process Loopback NOT AVAILABLE (using fallback)";
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &result);
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
        {"setWebRTCVideoCallback", nullptr, SetWebRTCVideoCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCAudioCallback", nullptr, SetWebRTCAudioCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setParticipantsVolume", nullptr, SetParticipantsVolume, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getParticipantsVolume", nullptr, GetParticipantsVolume, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)