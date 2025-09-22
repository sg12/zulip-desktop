#define NOMINMAX  // Предотвращаем конфликт с макросами min/max из Windows
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

// НОВАЯ ГЛОБАЛЬНАЯ ПЕРЕМЕННАЯ ДЛЯ УПРАВЛЕНИЯ ГРОМКОСТЬЮ
static std::atomic<float> g_participants_volume{0.20f};
static std::mutex g_volume_mutex;

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
    int width = 1;
    int height = 1;
    int fps = 1;
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

class UniversalEchoCanceller {
private:
    static constexpr int SAMPLE_RATE = 48000;
    static constexpr int MAX_DELAY_MS = 2000; // До 2 секунд
    static constexpr int MAX_DELAY_SAMPLES = (MAX_DELAY_MS * SAMPLE_RATE) / 1000;
    
    std::vector<float> ringBuffer;
    int writeIndex = 0;
    
    // Адаптивные параметры
    int detectedDelay = 0;
    float echoGain = 0.5f;
    int searchCounter = 0;
    
    // Статистика для автоопределения
    std::vector<float> correlationHistory;
    
public:
    UniversalEchoCanceller() {
        ringBuffer.resize(MAX_DELAY_SAMPLES, 0.0f);
        correlationHistory.resize(20, 0.0f); // История последних 20 измерений
    }
    
    void ProcessBuffer(std::vector<float>& samples) {
        // Автоматический поиск задержки каждые 50 фреймов
        if (++searchCounter % 50 == 0) {
            DetectEchoDelay(samples);
        }
        
        // Применяем подавление с найденной задержкой
        if (detectedDelay > 0) {
            ApplyEchoCancellation(samples);
        }
    }
    
private:
    void DetectEchoDelay(const std::vector<float>& samples) {
        float bestCorrelation = 0;
        int bestDelay = 0;
        
        // Используем переменный шаг в зависимости от задержки
        int delayMs = 100;
        while (delayMs <= 2000) {
            int delaySamples = (delayMs * SAMPLE_RATE) / 1000;
            float correlation = CalculateCorrelation(samples, delaySamples);
            
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestDelay = delaySamples;
            }
            
            // Переменный шаг: меньше для малых задержек, больше для больших
            if (delayMs < 500) {
                delayMs += 25;  // Шаг 25мс для задержек < 500мс
            } else if (delayMs < 1000) {
                delayMs += 50;  // Шаг 50мс для задержек 500-1000мс
            } else {
                delayMs += 100; // Шаг 100мс для задержек > 1000мс
            }
        }
        
        // Уточняющий проход с шагом 1мс вокруг максимума
        if (bestCorrelation > 0.25f) {
            int centerMs = (bestDelay * 1000) / SAMPLE_RATE;
            
            for (int delta = -10; delta <= 10; delta++) {
                int testMs = centerMs + delta;
                if (testMs < 100 || testMs > 2000) continue;
                
                int delaySamples = (testMs * SAMPLE_RATE) / 1000;
                float correlation = CalculateCorrelation(samples, delaySamples);
                
                if (correlation > bestCorrelation) {
                    bestCorrelation = correlation;
                    bestDelay = delaySamples;
                }
            }
        }
        
        // Применяем результат
        if (bestCorrelation > 0.3f) {
            detectedDelay = bestDelay;
            echoGain = std::min(0.9f, bestCorrelation);
            
            char log[256];
            sprintf_s(log, "[ECHO] Precise delay: %d.%dms, correlation: %.3f\n", 
                    (bestDelay * 1000) / SAMPLE_RATE,
                    ((bestDelay * 10000) / SAMPLE_RATE) % 10,
                    bestCorrelation);
            OutputDebugStringA(log);
        }
    }
    
    float CalculateCorrelation(const std::vector<float>& samples, int delaySamples) {
        // Используем последние 2000 сэмплов для анализа
        int analyzeLength = std::min(2000, (int)samples.size());
        if (analyzeLength < 100) return 0;
        
        float correlation = 0;
        float energy1 = 0;
        float energy2 = 0;
        
        for (int i = 0; i < analyzeLength; i++) {
            int currentIdx = samples.size() - analyzeLength + i;
            int delayedIdx = (writeIndex - delaySamples - analyzeLength + i + MAX_DELAY_SAMPLES) % MAX_DELAY_SAMPLES;
            
            float current = samples[currentIdx];
            float delayed = ringBuffer[delayedIdx];
            
            correlation += current * delayed;
            energy1 += current * current;
            energy2 += delayed * delayed;
        }
        
        if (energy1 > 0.0001f && energy2 > 0.0001f) {
            return fabs(correlation) / (sqrt(energy1) * sqrt(energy2));
        }
        
        return 0;
    }
    
    void ApplyEchoCancellation(std::vector<float>& samples) {
        for (size_t i = 0; i < samples.size(); i++) {
            // Сохраняем текущий сэмпл
            ringBuffer[writeIndex] = samples[i];
            
            // Получаем задержанный сэмпл
            int echoIdx = (writeIndex - detectedDelay + MAX_DELAY_SAMPLES) % MAX_DELAY_SAMPLES;
            float echoSample = ringBuffer[echoIdx];
            
            // Адаптивное вычитание
            float cleaned = samples[i] - (echoSample * echoGain);
            
            // Ограничитель для предотвращения искажений
            float inputLevel = fabs(samples[i]);
            float outputLevel = fabs(cleaned);
            
            // Если после вычитания сигнал стал громче - что-то не так
            if (outputLevel > inputLevel * 1.5f) {
                // Уменьшаем агрессивность
                cleaned = samples[i] - (echoSample * echoGain * 0.5f);
                echoGain *= 0.95f; // Адаптивно уменьшаем
            }
            
            // Noise gate для остаточного эха
            if (outputLevel < inputLevel * 0.1f) {
                cleaned *= 0.5f;
            }
            
            samples[i] = cleaned;
            writeIndex = (writeIndex + 1) % MAX_DELAY_SAMPLES;
        }
    }
};

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
                Sleep(100); // Обновляем каждые 100мс
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
                
                // Применяем громкость только к другим процессам (не к нашему Electron)
                if (SUCCEEDED(hr) && processId != currentProcessId && processId != 0) {
                    
                    // Проверяем, является ли это браузером или коммуникационным приложением
                    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
                    if (hProcess) {
                        wchar_t exePath[MAX_PATH];
                        DWORD pathLen = MAX_PATH;
                        if (QueryFullProcessImageNameW(hProcess, 0, exePath, &pathLen)) {
                            std::wstring fullPath(exePath);
                            
                            // Проверяем, является ли это браузером или VoIP приложением
                            if (fullPath.find(L"chrome.exe") != std::wstring::npos ||
                                fullPath.find(L"firefox.exe") != std::wstring::npos ||
                                fullPath.find(L"msedge.exe") != std::wstring::npos ||
                                fullPath.find(L"opera.exe") != std::wstring::npos ||
                                fullPath.find(L"brave.exe") != std::wstring::npos ||
                                fullPath.find(L"teams.exe") != std::wstring::npos ||
                                fullPath.find(L"zoom.exe") != std::wstring::npos ||
                                fullPath.find(L"skype.exe") != std::wstring::npos) {
                                
                                ISimpleAudioVolume* simpleVolume = nullptr;
                                hr = sessionControl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&simpleVolume);
                                
                                if (SUCCEEDED(hr)) {
                                    // Устанавливаем громкость
                                    simpleVolume->SetMasterVolume(targetVolume, nullptr);
                                    simpleVolume->Release();
                                    
                                    char log[256];
                                    sprintf_s(log, "Volume set to %.2f for PID: %lu\n", targetVolume, processId);
                                    OutputDebugStringA(log);
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
        
        // Восстанавливаем громкость всех приложений на 100%
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
        
        // Правильная очистка COM объектов
        if (sessionManager) {
            sessionManager->Release();
            sessionManager = nullptr;
        }
        if (device) {
            device->Release();
            device = nullptr;
        }
        if (deviceEnumerator) {
            deviceEnumerator->Release();
            deviceEnumerator = nullptr;
        }
        
        // Деинициализация COM для основного потока
        CoUninitialize();
    }
};

// Глобальный экземпляр контроллера громкости
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
        targetWidth = 1;
        targetHeight = 1;
        targetFps = 1;
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

// === НОВЫЙ КЛАСС для захвата звука от конкретного приложения ===
class ApplicationAudioCapture {
private:
    DWORD targetProcessId = 0;
    std::wstring applicationName;
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    IAudioSessionManager2* sessionManager = nullptr;
    WAVEFORMATEX* waveFormat = nullptr;
    
    UniversalEchoCanceller echoCanceller;
    bool echoEnabled = true;

    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    std::vector<float> accumulationBuffer;
    std::mutex bufferMutex;
    const int TARGET_FRAME_SIZE = 960;
    
    std::atomic<float> targetProcessVolume{0.0f};
    std::atomic<bool> isTargetProcessActive{false};
    
    LARGE_INTEGER performanceFrequency;
    LARGE_INTEGER captureStartTime;
    
public:
    bool InitializeForApplication(HWND hwnd) {
        CoInitialize(nullptr);
        
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        
        GetWindowThreadProcessId(hwnd, &targetProcessId);
        
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
            StartSessionMonitoring();
            OutputDebugStringA("Application audio capture initialized successfully\n");
        }
        
        return SUCCEEDED(hr);
    }
    
    void StartSessionMonitoring() {
        std::thread monitorThread([this]() {
            CoInitialize(nullptr);
            
            while (isCapturing) {
                UpdateTargetProcessVolume();
                Sleep(100);
            }
            
            CoUninitialize();
        });
        monitorThread.detach();
    }
    
    void UpdateTargetProcessVolume() {
        if (!sessionManager) return;
        
        IAudioSessionEnumerator* sessionEnumerator = nullptr;
        HRESULT hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
        if (FAILED(hr)) return;
        
        int sessionCount = 0;
        sessionEnumerator->GetCount(&sessionCount);
        
        bool foundTarget = false;
        float maxVolume = 0.0f;
        
        for (int i = 0; i < sessionCount; i++) {
            IAudioSessionControl* sessionControl = nullptr;
            hr = sessionEnumerator->GetSession(i, &sessionControl);
            if (FAILED(hr)) continue;
            
            IAudioSessionControl2* sessionControl2 = nullptr;
            hr = sessionControl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&sessionControl2);
            
            if (SUCCEEDED(hr)) {
                DWORD processId = 0;
                hr = sessionControl2->GetProcessId(&processId);
                
                if (SUCCEEDED(hr) && processId == targetProcessId) {
                    AudioSessionState state;
                    hr = sessionControl->GetState(&state);
                    
                    if (SUCCEEDED(hr) && state == AudioSessionStateActive) {
                        ISimpleAudioVolume* simpleVolume = nullptr;
                        hr = sessionControl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&simpleVolume);
                        
                        if (SUCCEEDED(hr)) {
                            float masterVolume = 0.0f;
                            simpleVolume->GetMasterVolume(&masterVolume);
                            
                            IAudioMeterInformation* meterInfo = nullptr;
                            hr = sessionControl->QueryInterface(__uuidof(IAudioMeterInformation), (void**)&meterInfo);
                            
                            if (SUCCEEDED(hr)) {
                                float peakValue = 0.0f;
                                meterInfo->GetPeakValue(&peakValue);
                                maxVolume = peakValue * masterVolume;
                                meterInfo->Release();
                            }
                            
                            simpleVolume->Release();
                        }
                        
                        foundTarget = true;
                    }
                }
                
                sessionControl2->Release();
            }
            
            sessionControl->Release();
        }
        
        targetProcessVolume = maxVolume;
        isTargetProcessActive = foundTarget;
        
        sessionEnumerator->Release();
    }
    
    bool InitializeForSystemAudio() {
        CoInitialize(nullptr);
        
        QueryPerformanceFrequency(&performanceFrequency);
        QueryPerformanceCounter(&captureStartTime);
        
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
        
        return SUCCEEDED(hr);
    }

    void EnableEchoCancellation(bool enable) {
        echoEnabled = enable;
        OutputDebugStringA(enable ? 
            "Echo cancellation ENABLED\n" : 
            "Echo cancellation DISABLED\n");
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
            OutputDebugStringA("Application audio capture started\n");
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
        
        // ============================================
        // КОНВЕРТАЦИЯ В FLOAT
        // ============================================
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
        
        // ============================================
        // ЭХОПОДАВЛЕНИЕ
        // ============================================
        if (echoEnabled) {
            // Если стерео - обрабатываем каждый канал
            if (waveFormat->nChannels == 2) {
                std::vector<float> leftChannel;
                std::vector<float> rightChannel;
                
                // Разделяем каналы
                for (size_t i = 0; i < samples.size(); i += 2) {
                    leftChannel.push_back(samples[i]);
                    rightChannel.push_back(samples[i + 1]);
                }
                
                // Обрабатываем каждый канал
                echoCanceller.ProcessBuffer(leftChannel);
                echoCanceller.ProcessBuffer(rightChannel);
                
                // Объединяем обратно
                for (size_t i = 0; i < leftChannel.size(); i++) {
                    samples[i * 2] = leftChannel[i];
                    samples[i * 2 + 1] = rightChannel[i];
                }
            } else {
                // Моно - обрабатываем напрямую
                echoCanceller.ProcessBuffer(samples);
            }
        }
        
        // ============================================
        // ФИНАЛЬНАЯ ОБРАБОТКА И ОТПРАВКА
        // ============================================
        
        // Применяем фильтрацию процесса (если нужно)
        if (targetProcessId != 0 && !echoEnabled) {
            ApplyProcessFilter(samples);
        }
        
        // Добавляем в буфер
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.insert(accumulationBuffer.end(), 
                                    samples.begin(), samples.end());
        }
        
        SendBufferedFrames();
    }
        
    void ApplyProcessFilter(std::vector<float>& samples) {
        // ВРЕМЕННО ОТКЛЮЧЕНО для отладки
        return;
        
        /* Оригинальный код фильтрации
        if (!isTargetProcessActive) {
            for (auto& sample : samples) {
                sample *= 0.1f;
            }
        } else {
            float volume = targetProcessVolume.load();
            if (volume < 0.1f) {
                for (auto& sample : samples) {
                    sample *= 0.2f;
                }
            }
        }
        */
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
            frameData->isSystemAudio = (targetProcessId == 0);
            
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
        
        OutputDebugStringA("Application audio capture stopped\n");
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

// Тестовый метод
napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, "Windows Native Module v1.0 - Application Audio Support with Volume Control", NAPI_AUTO_LENGTH, &result);
    return result;
}

napi_value SetParticipantsVolume(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    
    float volume = 0.20f; // Значение по умолчанию
    
    if (argc >= 1) {
        double inputVolume;
        napi_status status = napi_get_value_double(env, argv[0], &inputVolume);
        
        if (status == napi_ok) {
            // Ограничиваем значение от 0 до 1
            volume = (float)std::max(0.0, std::min(1.0, inputVolume));
        }
    }
    
    // Устанавливаем новое значение громкости
    {
        std::lock_guard<std::mutex> lock(g_volume_mutex);
        g_participants_volume = volume;
    }
    
    char log[128];
    sprintf_s(log, "Participants volume set to: %.2f\n", volume);
    OutputDebugStringA(log);
    
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success, volumeSet;
    napi_get_boolean(env, true, &success);
    napi_create_double(env, volume, &volumeSet);
    
    napi_set_named_property(env, result, "success", success);
    napi_set_named_property(env, result, "volume", volumeSet);
    
    return result;
}

// НОВАЯ ФУНКЦИЯ: Получение текущей громкости участников
napi_value GetParticipantsVolume(napi_env env, napi_callback_info info) {
    float currentVolume = g_participants_volume.load();
    
    napi_value result;
    napi_create_double(env, currentVolume, &result);
    
    return result;
}

// Callback функция для перечисления окон
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
    // ИГНОРИРУЕМ входящие параметры
    // Всегда используем минимум для экономии CPU  
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

// Начало захвата
napi_value StartCapture(napi_env env, napi_callback_info info) {
    g_syncManager.Initialize();
    g_syncManager.Reset();
    OutputDebugStringA("Sync manager initialized\n");
    
    // Инициализируем и запускаем контроллер громкости
    if (!g_volumeController) {
        CoInitialize(nullptr); // Инициализация COM для главного потока
        g_volumeController = std::make_unique<VolumeController>();
        if (g_volumeController->Initialize()) {
            g_volumeController->StartVolumeControl();
            OutputDebugStringA("Volume controller started\n");
        } else {
            OutputDebugStringA("Failed to initialize volume controller\n");
            g_volumeController.reset(); // Очищаем если не удалось инициализировать
        }
    }
    
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
    
    // Запускаем аудио захват с поддержкой захвата от приложений
    if (g_currentSource.type == "window") {
        try {
            HWND hwnd = (HWND)std::stoull(g_currentSource.id);
            
            if (IsWindow(hwnd)) {
                g_appAudioCapture = std::make_unique<ApplicationAudioCapture>();
                
                if (g_appAudioCapture->InitializeForApplication(hwnd)) {
                    g_appAudioCapture->StartCapture();
                    audioStarted = true;
                    OutputDebugStringA("Started application-specific audio capture\n");
                } else {
                    if (g_appAudioCapture->InitializeForSystemAudio()) {
                        g_appAudioCapture->StartCapture();
                        audioStarted = true;
                        OutputDebugStringA("Fallback to system audio capture\n");
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
            OutputDebugStringA("Started system audio capture\n");
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
    if (audioStarted) msg += "audio";
    napi_create_string_utf8(env, msg.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_set_named_property(env, result, "message", message);
    
    return result;
}

// Остановка захвата
napi_value StopCapture(napi_env env, napi_callback_info info) {
    g_capture_active = false;
    
    // Останавливаем контроллер громкости
    if (g_volumeController) {
        g_volumeController->StopVolumeControl();
        g_volumeController.reset();
        CoUninitialize(); // Деинициализация COM
        OutputDebugStringA("Volume controller stopped and cleaned up\n");
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
        {"setWebRTCVideoCallback", nullptr, SetWebRTCVideoCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWebRTCAudioCallback", nullptr, SetWebRTCAudioCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setParticipantsVolume", nullptr, SetParticipantsVolume, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getParticipantsVolume", nullptr, GetParticipantsVolume, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)