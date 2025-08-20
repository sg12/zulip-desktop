#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
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
};

// Структура для хранения информации об источнике
struct CaptureSource {
    std::string type;  // "display", "window", "application"
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

GetTimestamp() {
    // БЫЛО: используется std::chrono::high_resolution_clock
    // ПРОБЛЕМА: не синхронизирован с JavaScript performance.now()
    
    // СТАЛО: используем QueryPerformanceCounter для Windows
    #ifdef _WIN32
        static LARGE_INTEGER frequency;
        static LARGE_INTEGER startTime;
        static bool initialized = false;
        
        if (!initialized) {
            QueryPerformanceFrequency(&frequency);
            QueryPerformanceCounter(&startTime);
            initialized = true;
        }
        
        LARGE_INTEGER currentTime;
        QueryPerformanceCounter(&currentTime);
        
        // Возвращаем в миллисекундах для совместимости с JS
        double elapsed = (double)(currentTime.QuadPart - startTime.QuadPart);
        return (elapsed / frequency.QuadPart) * 1000.0;
    #else
        // Для других платформ оставляем как было
        static auto start = std::chrono::high_resolution_clock::now();
        auto now = std::chrono::high_resolution_clock::now();
        return std::chrono::duration<double, std::milli>(now - start).count();
    #endif
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
    
public:
    bool Initialize(int displayId) {
        OutputDebugStringA("DXGIScreenCapture::Initialize starting\n");
        
        // Создаем D3D11 устройство
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
        
        // Получаем DXGI адаптер
        IDXGIDevice* dxgiDevice = nullptr;
        hr = device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice);
        if (FAILED(hr)) return false;
        
        IDXGIAdapter* adapter = nullptr;
        hr = dxgiDevice->GetAdapter(&adapter);
        dxgiDevice->Release();
        if (FAILED(hr)) return false;
        
        // Получаем нужный output
        IDXGIOutput* output = nullptr;
        hr = adapter->EnumOutputs(displayId, &output);
        adapter->Release();
        if (FAILED(hr)) return false;
        
        // Получаем IDXGIOutput1
        IDXGIOutput1* output1 = nullptr;
        hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
        output->Release();
        if (FAILED(hr)) return false;
        
        // Создаем дупликацию экрана
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
        int frameInterval = 1000 / targetFps; // миллисекунды между кадрами
        
        while (isCapturing) {
            auto frameStart = std::chrono::high_resolution_clock::now();
            
            IDXGIResource* desktopResource = nullptr;
            DXGI_OUTDUPL_FRAME_INFO frameInfo;
            
            // Получаем следующий кадр (таймаут 100мс)
            HRESULT hr = duplication->AcquireNextFrame(100, &frameInfo, &desktopResource);
            
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                continue; // Нет новых кадров
            }
            
            if (SUCCEEDED(hr) && desktopResource) {
                // Конвертируем в текстуру
                ID3D11Texture2D* texture = nullptr;
                hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&texture);
                
                if (SUCCEEDED(hr) && texture) {
                    ProcessFrame(texture);
                    texture->Release();
                }
                
                desktopResource->Release();
                duplication->ReleaseFrame();
            } else if (hr == DXGI_ERROR_ACCESS_LOST) {
                // Нужно переинициализировать дупликацию
                OutputDebugStringA("DXGI_ERROR_ACCESS_LOST - need to reinitialize\n");
                break;
            }
            
            // Контроль FPS
            auto frameEnd = std::chrono::high_resolution_clock::now();
            auto frameDuration = std::chrono::duration_cast<std::chrono::milliseconds>(frameEnd - frameStart).count();
            if (frameDuration < frameInterval) {
                Sleep(frameInterval - frameDuration);
            }
        }
    }
    
    void ProcessFrame(ID3D11Texture2D* texture) {
        static int frameCount = 0;
        if (++frameCount % 30 == 0) { // Каждые 30 кадров
            char log[128];
            sprintf_s(log, "ProcessFrame: frame %d\n", frameCount);
            OutputDebugStringA(log);
        }
        
        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);
        
        // Создаем staging текстуру для чтения CPU
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        
        ID3D11Texture2D* stagingTexture = nullptr;
        HRESULT hr = device->CreateTexture2D(&desc, nullptr, &stagingTexture);
        
        if (FAILED(hr) || !stagingTexture) return;
        
        // Копируем данные
        context->CopyResource(stagingTexture, texture);
        
        // Мапим для чтения
        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = context->Map(stagingTexture, 0, D3D11_MAP_READ, 0, &mapped);
        
        if (SUCCEEDED(hr)) {
            // Создаем структуру с данными
            VideoFrameData* frameData = new VideoFrameData();
            frameData->width = targetWidth;
            frameData->height = targetHeight;
            frameData->timestamp = GetTimestamp();
            frameData->hasRealPixels = true;
            
            // Масштабируем если нужно
            if (desc.Width != targetWidth || desc.Height != targetHeight) {
                // Простое масштабирование
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
                        
                        // Копируем BGRA пиксель
                        memcpy(&dst[dstIdx], &src[srcIdx], 4);
                    }
                }
            } else {
                // Прямое копирование
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
            
            // Увеличиваем счетчик кадров
            g_video_frame_count++;
            
            // Отправляем в JavaScript callback
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

// Класс для захвата аудио через WASAPI
class WASAPIAudioCapture {
private:
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    WAVEFORMATEX* waveFormat = nullptr;
    std::atomic<bool> isCapturing{false};
    std::thread captureThread;
    bool isSystemAudio = true;
    
    // Добавляем буфер для накопления семплов
    std::vector<float> accumulationBuffer;
    std::mutex bufferMutex;
    const int TARGET_FRAME_SIZE = 240; // 5ms при 48kHz для меньшей латентности
    
public:
    bool Initialize(const std::string& sourceType, const std::string& sourceId) {
        CoInitialize(nullptr);
        
        HRESULT hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator),
            (void**)&deviceEnumerator
        );
        
        if (FAILED(hr)) return false;
        
        // Определяем тип захвата
        if (sourceType == "display" || sourceType == "screen" || sourceType == "window") {
            isSystemAudio = true;
            hr = deviceEnumerator->GetDefaultAudioEndpoint(
                eRender,  // Для системного звука
                eConsole,
                &device
            );
        } else if (sourceType == "microphone") {
            isSystemAudio = false;
            hr = deviceEnumerator->GetDefaultAudioEndpoint(
                eCapture,  // Для микрофона
                eConsole,
                &device
            );
        } else {
            // По умолчанию системный звук
            isSystemAudio = true;
            hr = deviceEnumerator->GetDefaultAudioEndpoint(
                eRender,
                eConsole,
                &device
            );
        }
        
        if (FAILED(hr)) return false;
        
        // Активируем audio client
        hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            (void**)&audioClient
        );
        
        if (FAILED(hr)) return false;
        
        // Получаем формат
        hr = audioClient->GetMixFormat(&waveFormat);
        if (FAILED(hr)) return false;
        
        // Логируем формат
        char log[256];
        sprintf_s(log, "WASAPI Format: Tag=0x%X, Bits=%d, Channels=%d, Rate=%d Hz\n",
                 waveFormat->wFormatTag, waveFormat->wBitsPerSample,
                 waveFormat->nChannels, waveFormat->nSamplesPerSec);
        OutputDebugStringA(log);
        
        // Инициализируем с оптимальным буфером
        DWORD streamFlags = isSystemAudio ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
        
        // Используем 20ms буфер для баланса между латентностью и стабильностью
        REFERENCE_TIME hnsRequestedDuration = 100000; // 10ms

        DWORD streamFlags = isSystemAudio ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;

        #ifdef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            streamFlags |= AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        #endif

        
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            streamFlags,
            hnsRequestedDuration,
            0,
            waveFormat,
            nullptr
        );
        
        if (FAILED(hr)) {
            sprintf_s(log, "WASAPI Initialize failed: 0x%08X\n", hr);
            OutputDebugStringA(log);
            return false;
        }
        
        // Получаем capture client
        hr = audioClient->GetService(
            __uuidof(IAudioCaptureClient),
            (void**)&captureClient
        );
        
        if (SUCCEEDED(hr)) {
            OutputDebugStringA("WASAPI Audio capture initialized successfully\n");
        }
        
        return SUCCEEDED(hr);
    }
    
    void StartCapture() {
        if (!audioClient) return;
        
        isCapturing = true;
        
        // Очищаем буфер перед началом
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.clear();
            accumulationBuffer.reserve(96000); // Резервируем место для 1 секунды
        }
        
        HRESULT hr = audioClient->Start();
        
        if (SUCCEEDED(hr)) {
            captureThread = std::thread([this]() {
                // Устанавливаем COM для этого потока
                CoInitialize(nullptr);
                CaptureLoop();
                CoUninitialize();
            });
            OutputDebugStringA("WASAPI Audio capture started\n");
        }
    }
    
    void CaptureLoop() {
        // === КРИТИЧНОЕ ИЗМЕНЕНИЕ: Более высокий приоритет ===
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        
        // === КРИТИЧНОЕ ИЗМЕНЕНИЕ: Привязка к конкретному ядру CPU ===
        SetThreadAffinityMask(GetCurrentThread(), 1 << 2); // Ядро 2
        
        while (isCapturing) {
            UINT32 packetLength = 0;
            HRESULT hr = captureClient->GetNextPacketSize(&packetLength);
            
            if (SUCCEEDED(hr) && packetLength > 0) {
                BYTE* data = nullptr;
                UINT32 numFramesAvailable;
                DWORD flags;
                UINT64 position;
                UINT64 qpcPosition; // === НОВОЕ: QPC позиция для точного тайминга
                
                hr = captureClient->GetBuffer(
                    &data,
                    &numFramesAvailable,
                    &flags,
                    &position,      // Используем позицию
                    &qpcPosition    // Используем QPC позицию
                );
                
                if (SUCCEEDED(hr)) {
                    if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && numFramesAvailable > 0) {
                        ProcessAudioData(data, numFramesAvailable);
                    } else if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        ProcessSilence(numFramesAvailable);
                    }
                    
                    captureClient->ReleaseBuffer(numFramesAvailable);
                }
            } else {
                // === КРИТИЧНОЕ ИЗМЕНЕНИЕ: Более короткий sleep ===
                Sleep(2); // Было 5ms, стало 2ms
            }
        }
    }
    
    void ProcessAudioData(BYTE* data, UINT32 numFrames) {
        size_t sampleCount = numFrames * waveFormat->nChannels;
        std::vector<float> samples(sampleCount);
        
        // === КРИТИЧНОЕ ИЗМЕНЕНИЕ №1: Правильная конвертация для Windows ===
        if (waveFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            // Для EXTENSIBLE проверяем SubFormat
            WAVEFORMATEXTENSIBLE* pWaveFormatExt = (WAVEFORMATEXTENSIBLE*)waveFormat;
            
            if (IsEqualGUID(pWaveFormatExt->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
                // Float формат
                float* srcFloat = (float*)data;
                for (size_t i = 0; i < sampleCount; i++) {
                    samples[i] = srcFloat[i];
                    // КРИТИЧНО: клампинг для защиты от искажений
                    if (!isfinite(samples[i])) samples[i] = 0.0f;
                    else if (samples[i] > 1.0f) samples[i] = 1.0f;
                    else if (samples[i] < -1.0f) samples[i] = -1.0f;
                }
            } else if (IsEqualGUID(pWaveFormatExt->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
                // PCM в EXTENSIBLE
                ConvertPCMToFloat(data, samples.data(), sampleCount, waveFormat->wBitsPerSample);
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
            // Обычный float
            float* srcFloat = (float*)data;
            for (size_t i = 0; i < sampleCount; i++) {
                samples[i] = std::clamp(srcFloat[i], -1.0f, 1.0f);
            }
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_PCM) {
            ConvertPCMToFloat(data, samples.data(), sampleCount, waveFormat->wBitsPerSample);
        }
        
        // === КРИТИЧНОЕ ИЗМЕНЕНИЕ №2: Добавляем временную метку ===
        double currentTimestamp = GetTimestamp(); // Используем новый GetTimestamp
        
        // Накапливаем в буфер
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.insert(accumulationBuffer.end(), 
                                    samples.begin(), samples.end());
        }
        
        // === КРИТИЧНОЕ ИЗМЕНЕНИЕ №3: Передаем timestamp в SendBufferedFrames ===
        SendBufferedFrames(currentTimestamp);
    }

    void ConvertPCMToFloat(BYTE* pcmData, float* output, size_t sampleCount, WORD bitsPerSample) {
        if (bitsPerSample == 16) {
            INT16* src = (INT16*)pcmData;
            for (size_t i = 0; i < sampleCount; i++) {
                output[i] = src[i] / 32768.0f;
            }
        } else if (bitsPerSample == 24) {
            for (size_t i = 0; i < sampleCount; i++) {
                BYTE* samplePtr = pcmData + (i * 3);
                INT32 sample = (samplePtr[0] | (samplePtr[1] << 8) | (samplePtr[2] << 16));
                if (sample & 0x800000) sample |= 0xFF000000;
                output[i] = sample / 8388608.0f;
            }
        } else if (bitsPerSample == 32) {
            INT32* src = (INT32*)pcmData;
            for (size_t i = 0; i < sampleCount; i++) {
                output[i] = src[i] / 2147483648.0f;
            }
        }
    }
    
    void ProcessSilence(UINT32 numFrames) {
        size_t sampleCount = numFrames * waveFormat->nChannels;
        std::vector<float> silence(sampleCount, 0.0f);
        
        // Добавляем тишину в буфер
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.insert(accumulationBuffer.end(), 
                                     silence.begin(), silence.end());
        }
        
        SendBufferedFrames();
    }
    
    void SendBufferedFrames(double baseTimestamp = -1) {
        // Если timestamp не передан, используем текущее время
        if (baseTimestamp < 0) {
            baseTimestamp = GetTimestamp();
        }
        
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
            
            // === КРИТИЧНОЕ ИЗМЕНЕНИЕ: Точная временная метка для каждого фрейма ===
            // Вычисляем offset на основе позиции в буфере
            double sampleOffset = (frameData->numSamples * 1000.0) / waveFormat->nSamplesPerSec;
            frameData->timestamp = baseTimestamp + sampleOffset;
            
            frameData->isSystemAudio = isSystemAudio;
            
            size_t frameSampleCount = TARGET_FRAME_SIZE * waveFormat->nChannels;
            frameData->samples = new float[frameSampleCount];
            
            std::copy(accumulationBuffer.begin(), 
                    accumulationBuffer.begin() + frameSampleCount,
                    frameData->samples);
            
            accumulationBuffer.erase(accumulationBuffer.begin(), 
                                accumulationBuffer.begin() + frameSampleCount);
            
            lock.unlock();
            
            // === КРИТИЧНОЕ ИЗМЕНЕНИЕ: НЕ применяем сглаживание для Windows ===
            // ApplySmoothFilter создает задержку и искажения
            // Закомментировать или сделать условным:
            #ifndef _WIN32
                ApplySmoothFilter(frameData->samples, frameSampleCount, waveFormat->nChannels);
            #endif
            
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
    
    void ApplySmoothFilter(float* samples, size_t sampleCount, int channels) {
        // Очень легкий фильтр для уменьшения щелчков
        static std::vector<float> prevSample(channels, 0.0f);
        const float alpha = 0.98f; // Меньше фильтрации для сохранения качества
        
        for (int ch = 0; ch < channels; ch++) {
            for (size_t i = ch; i < sampleCount; i += channels) {
                float current = samples[i];
                float filtered = alpha * current + (1.0f - alpha) * prevSample[ch];
                samples[i] = filtered;
                prevSample[ch] = current;
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
        
        // Очищаем буфер
        {
            std::lock_guard<std::mutex> lock(bufferMutex);
            accumulationBuffer.clear();
        }
        
        OutputDebugStringA("WASAPI Audio capture stopped\n");
    }
    
    ~WASAPIAudioCapture() {
        StopCapture();
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
static std::unique_ptr<WASAPIAudioCapture> g_audioCapture;
static CaptureSource g_currentSource;

// === N-API функции ===

// Тестовый метод
napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, "Windows Native Module v1.0 - REAL", NAPI_AUTO_LENGTH, &result);
    return result;
}

// Callback функция для перечисления окон
BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    // Пропускаем невидимые окна
    if (!IsWindowVisible(hwnd)) return TRUE;
    
    // Получаем заголовок окна
    char windowTitle[256];
    GetWindowTextA(hwnd, windowTitle, sizeof(windowTitle));
    
    // Пропускаем окна без заголовка
    if (strlen(windowTitle) == 0) return TRUE;
    
    // Получаем стиль окна
    DWORD style = GetWindowLong(hwnd, GWL_STYLE);
    DWORD exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
    
    // Пропускаем дочерние окна и инструментальные окна
    if ((style & WS_CHILD) || (exStyle & WS_EX_TOOLWINDOW)) return TRUE;
    
    // Пропускаем окна без WS_VISIBLE
    if (!(style & WS_VISIBLE)) return TRUE;
    
    // Получаем размеры окна
    RECT rect;
    GetWindowRect(hwnd, &rect);
    int width = rect.right - rect.left;
    int height = rect.bottom - rect.top;
    
    // Пропускаем слишком маленькие окна (вероятно, скрытые или системные)
    if (width < 100 || height < 100) return TRUE;
    
    // Проверяем, не является ли окно cloaked (Windows 10+ для виртуальных рабочих столов)
    DWORD cloaked = 0;
    HRESULT hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (SUCCEEDED(hr) && cloaked != 0) return TRUE;
    
    // Получаем имя процесса для дополнительной информации
    DWORD processId;
    GetWindowThreadProcessId(hwnd, &processId);
    
    std::string processName = "";
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (hProcess) {
        char exePath[MAX_PATH];
        DWORD pathLen = MAX_PATH;
        if (QueryFullProcessImageNameA(hProcess, 0, exePath, &pathLen)) {
            // Извлекаем только имя файла из полного пути
            std::string fullPath(exePath);
            size_t lastSlash = fullPath.find_last_of("\\/");
            if (lastSlash != std::string::npos) {
                processName = fullPath.substr(lastSlash + 1);
                // Убираем .exe расширение
                size_t dotPos = processName.find_last_of(".");
                if (dotPos != std::string::npos) {
                    processName = processName.substr(0, dotPos);
                }
            }
        }
        CloseHandle(hProcess);
    }
    
    // Получаем указатель на вектор sources
    auto* data = (EnumWindowsData*)lParam;
    
    // Создаем источник
    CaptureSource source;
    source.type = "window";
    source.id = std::to_string((intptr_t)hwnd);
    
    // Формируем имя: "Заголовок окна (Имя приложения)"
    source.name = std::string(windowTitle);
    if (!processName.empty()) {
        source.name += " (" + processName + ")";
    }
    
    source.width = width;
    source.height = height;
    
    data->sources->push_back(source);
    
    return TRUE; // Продолжаем перечисление
}

// Получение доступных источников
napi_value GetAvailableSources(napi_env env, napi_callback_info info) {
    napi_value array;
    napi_create_array(env, &array);
    
    std::vector<CaptureSource> sources;
    
    // === 1. Перечисляем дисплеи через DXGI ===
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
                
                // Конвертируем имя монитора из широких символов
                char monitorName[32];
                wcstombs(monitorName, desc.DeviceName, sizeof(monitorName));
                
                CaptureSource source;
                source.type = "screen";
                source.id = "display_" + std::to_string(outputIndex);
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
    
    // === 2. Добавляем "Entire Screen" как специальный источник ===
    // Это будет захватывать все мониторы сразу
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
    
    // === 3. Перечисляем все окна ===
    EnumWindowsData enumData;
    enumData.sources = &sources;
    EnumWindows(EnumWindowsProc, (LPARAM)&enumData);
    
    // === 4. Добавляем специальные источники для популярных приложений ===
    // Можно добавить проверку на конкретные приложения
    for (auto& source : sources) {
        if (source.type == "window") {
            // Помечаем медиаплееры, браузеры и т.д. специальными тегами
            std::string lowerName = source.name;
            std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::tolower);
            
            if (lowerName.find("media player") != std::string::npos ||
                lowerName.find("vlc") != std::string::npos ||
                lowerName.find("movies & tv") != std::string::npos ||
                lowerName.find("films & tv") != std::string::npos) {
                // Можно добавить специальную метку для медиаплееров
                source.name = "🎬 " + source.name;
            }
            else if (lowerName.find("chrome") != std::string::npos ||
                     lowerName.find("firefox") != std::string::npos ||
                     lowerName.find("edge") != std::string::npos) {
                source.name = "🌐 " + source.name;
            }
        }
    }
    
    // === 5. Конвертируем в JavaScript массив ===
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
    
    // Получаем type и id
    napi_value typeVal, idVal;
    napi_get_named_property(env, argv[0], "type", &typeVal);
    napi_get_named_property(env, argv[0], "id", &idVal);
    
    char type[256], id[256];
    size_t typeLen, idLen;
    napi_get_value_string_utf8(env, typeVal, type, sizeof(type), &typeLen);
    napi_get_value_string_utf8(env, idVal, id, sizeof(id), &idLen);
    
    // Сохраняем текущий источник
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
    
    int32_t width, height, fps;
    napi_get_value_int32(env, widthVal, &width);
    napi_get_value_int32(env, heightVal, &height);
    napi_get_value_int32(env, fpsVal, &fps);
    
    // Сохраняем настройки качества
    {
        std::lock_guard<std::mutex> lock(g_quality.mutex);
        g_quality.width = width;
        g_quality.height = height;
        g_quality.fps = fps;
    }
    
    // Применяем к текущему захвату если он активен
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

// Начало захвата
napi_value StartCapture(napi_env env, napi_callback_info info) {
    // Останавливаем предыдущий захват
    if (g_screenCapture) {
        g_screenCapture->StopCapture();
        g_screenCapture.reset();
    }
    if (g_audioCapture) {
        g_audioCapture->StopCapture();
        g_audioCapture.reset();
    }
    
    // Создаем новые экземпляры
    bool videoStarted = false;
    bool audioStarted = false;
    
    // Запускаем видео захват
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
            // Применяем настройки качества
            std::lock_guard<std::mutex> lock(g_quality.mutex);
            g_screenCapture->SetQuality(1, 1, 1);
            
            g_screenCapture->StartCapture();
            videoStarted = true;
        }
    }
    
    // Запускаем аудио захват
    g_audioCapture = std::make_unique<WASAPIAudioCapture>();
    if (g_audioCapture->Initialize(g_currentSource.type, g_currentSource.id)) {
        g_audioCapture->StartCapture();
        audioStarted = true;
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
    
    if (g_screenCapture) {
        g_screenCapture->StopCapture();
        g_screenCapture.reset();
    }
    
    if (g_audioCapture) {
        g_audioCapture->StopCapture();
        g_audioCapture.reset();
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
    
    // Удаляем старый callback если есть
    if (g_video_tsfn) {
        napi_release_threadsafe_function(g_video_tsfn, napi_tsfn_release);
        g_video_tsfn = nullptr;
    }
    
    // Создаем новый threadsafe function
    napi_value work_name;
    napi_create_string_utf8(env, "WebRTCVideoCallback", NAPI_AUTO_LENGTH, &work_name);
    
    napi_create_threadsafe_function(
        env,
        argv[0],  // JavaScript функция
        nullptr,  // async_resource
        work_name,  // async_resource_name
        0,  // max_queue_size (unlimited)
        1,  // initial_thread_count
        nullptr,  // thread_finalize_data
        nullptr,  // thread_finalize_cb
        nullptr,  // context
        [](napi_env env, napi_value js_callback, void* context, void* data) {
            // Вызывается в главном потоке JavaScript
            VideoFrameData* frameData = (VideoFrameData*)data;
            
            napi_value videoInfo;
            napi_create_object(env, &videoInfo);
            
            // Добавляем метаданные
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
            
            // Создаем ArrayBuffer с пикселями
            if (frameData->hasRealPixels && frameData->data) {
                void* buffer_data;
                napi_value arrayBuffer;
                napi_create_arraybuffer(env, frameData->dataSize, &buffer_data, &arrayBuffer);
                memcpy(buffer_data, frameData->data, frameData->dataSize);
                napi_set_named_property(env, videoInfo, "data", arrayBuffer);
            }
            
            // Вызываем JavaScript callback
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_status status = napi_call_function(env, global, js_callback, 1, &videoInfo, &result);
            
            // Очищаем память
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
    
    // Удаляем старый callback если есть
    if (g_audio_tsfn) {
        napi_release_threadsafe_function(g_audio_tsfn, napi_tsfn_release);
        g_audio_tsfn = nullptr;
    }
    
    // Создаем новый threadsafe function
    napi_value work_name;
    napi_create_string_utf8(env, "WebRTCAudioCallback", NAPI_AUTO_LENGTH, &work_name);
    
    napi_create_threadsafe_function(
        env,
        argv[0],  // JavaScript функция
        nullptr,  // async_resource
        work_name,  // async_resource_name
        0,  // max_queue_size (unlimited)
        1,  // initial_thread_count
        nullptr,  // thread_finalize_data
        nullptr,  // thread_finalize_cb
        nullptr,  // context
        [](napi_env env, napi_value js_callback, void* context, void* data) {
            // Вызывается в главном потоке JavaScript
            AudioFrameData* frameData = (AudioFrameData*)data;
            
            napi_value audioInfo;
            napi_create_object(env, &audioInfo);
            
            // Добавляем метаданные
            napi_value sampleRate, channels, timestamp, numSamples, frameNumber, source;
            napi_create_int32(env, frameData->sampleRate, &sampleRate);
            napi_create_int32(env, frameData->channels, &channels);
            napi_create_double(env, frameData->timestamp, &timestamp);
            napi_create_int32(env, frameData->numSamples, &numSamples);
            napi_create_double(env, (double)g_audio_frame_count.load(), &frameNumber);
            napi_create_string_utf8(env, frameData->isSystemAudio ? "system" : "microphone", 
                                   NAPI_AUTO_LENGTH, &source);
            
            napi_set_named_property(env, audioInfo, "sampleRate", sampleRate);
            napi_set_named_property(env, audioInfo, "channels", channels);
            napi_set_named_property(env, audioInfo, "timestamp", timestamp);
            napi_set_named_property(env, audioInfo, "numSamples", numSamples);
            napi_set_named_property(env, audioInfo, "frameNumber", frameNumber);
            napi_set_named_property(env, audioInfo, "source", source);
            
            // Создаем ArrayBuffer с сэмплами
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
            
            // Вызываем JavaScript callback
            napi_value global;
            napi_get_global(env, &global);
            
            napi_value result;
            napi_status status = napi_call_function(env, global, js_callback, 1, &audioInfo, &result);
            
            // Очищаем память
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
    // Базовые методы
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