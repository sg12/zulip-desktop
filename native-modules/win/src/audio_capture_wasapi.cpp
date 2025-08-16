#include <node_api.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <thread>
#include <atomic>

class AudioCaptureWASAPI {
private:
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* audioClient = nullptr;
    IAudioCaptureClient* captureClient = nullptr;
    WAVEFORMATEX* waveFormat = nullptr;
    
    std::thread captureThread;
    std::atomic<bool> isCapturing{false};
    napi_threadsafe_function audioCallback = nullptr;
    
public:
    AudioCaptureWASAPI() {
        CoInitialize(nullptr);
    }
    
    ~AudioCaptureWASAPI() {
        StopCapture();
        Cleanup();
        CoUninitialize();
    }
    
    bool Initialize() {
        HRESULT hr;
        
        // Создаем enumerator устройств
        hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator),
            (void**)&deviceEnumerator
        );
        
        if (FAILED(hr)) return false;
        
        // Получаем устройство по умолчанию для рендеринга (системный звук)
        // Используем eRender вместо eCapture для захвата системного звука
        hr = deviceEnumerator->GetDefaultAudioEndpoint(
            eRender,  // Важно! Для системного звука
            eConsole,
            &device
        );
        
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
        
        // Инициализируем в режиме loopback для захвата системного звука
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,  // ВАЖНО! Loopback для системного звука
            10000000,  // 1 секунда буфера
            0,
            waveFormat,
            nullptr
        );
        
        if (FAILED(hr)) return false;
        
        // Получаем capture client
        hr = audioClient->GetService(
            __uuidof(IAudioCaptureClient),
            (void**)&captureClient
        );
        
        return SUCCEEDED(hr);
    }
    
    bool StartCapture(napi_threadsafe_function callback) {
        if (isCapturing) return false;
        
        audioCallback = callback;
        isCapturing = true;
        
        HRESULT hr = audioClient->Start();
        if (FAILED(hr)) {
            isCapturing = false;
            return false;
        }
        
        // Запускаем поток захвата
        captureThread = std::thread([this]() {
            CaptureLoop();
        });
        
        return true;
    }
    
    void CaptureLoop() {
        HRESULT hr;
        UINT32 packetLength = 0;
        BYTE* data = nullptr;
        UINT32 numFramesAvailable;
        DWORD flags;
        
        while (isCapturing) {
            // Ждем данные
            Sleep(10);
            
            hr = captureClient->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) break;
            
            while (packetLength != 0) {
                // Получаем доступные данные
                hr = captureClient->GetBuffer(
                    &data,
                    &numFramesAvailable,
                    &flags,
                    nullptr,
                    nullptr
                );
                
                if (SUCCEEDED(hr)) {
                    // Конвертируем в float и отправляем в JavaScript
                    if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && audioCallback) {
                        SendAudioData(data, numFramesAvailable);
                    }
                    
                    captureClient->ReleaseBuffer(numFramesAvailable);
                }
                
                hr = captureClient->GetNextPacketSize(&packetLength);
                if (FAILED(hr)) break;
            }
        }
    }
    
    void SendAudioData(BYTE* data, UINT32 numFrames) {
        if (!audioCallback) return;
        
        // Создаем структуру для передачи в JS
        struct AudioData {
            float* samples;
            UINT32 numSamples;
            UINT32 sampleRate;
            UINT32 channels;
        };
        
        // Конвертируем данные в float
        float* floatData = new float[numFrames * waveFormat->nChannels];
        
        if (waveFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
            // Уже float
            memcpy(floatData, data, numFrames * waveFormat->nChannels * sizeof(float));
        } else if (waveFormat->wFormatTag == WAVE_FORMAT_PCM) {
            // Конвертируем из PCM в float
            if (waveFormat->wBitsPerSample == 16) {
                INT16* pcmData = (INT16*)data;
                for (UINT32 i = 0; i < numFrames * waveFormat->nChannels; i++) {
                    floatData[i] = pcmData[i] / 32768.0f;
                }
            }
        }
        
        AudioData audioData = {
            floatData,
            numFrames,
            waveFormat->nSamplesPerSec,
            waveFormat->nChannels
        };
        
        // Вызываем JavaScript callback
        napi_call_threadsafe_function(
            audioCallback,
            &audioData,
            napi_tsfn_blocking
        );
        
        delete[] floatData;
    }
    
    bool StopCapture() {
        if (!isCapturing) return false;
        
        isCapturing = false;
        
        if (audioClient) {
            audioClient->Stop();
        }
        
        if (captureThread.joinable()) {
            captureThread.join();
        }
        
        return true;
    }
    
    void Cleanup() {
        if (captureClient) {
            captureClient->Release();
            captureClient = nullptr;
        }
        
        if (audioClient) {
            audioClient->Release();
            audioClient = nullptr;
        }
        
        if (device) {
            device->Release();
            device = nullptr;
        }
        
        if (deviceEnumerator) {
            deviceEnumerator->Release();
            deviceEnumerator = nullptr;
        }
        
        if (waveFormat) {
            CoTaskMemFree(waveFormat);
            waveFormat = nullptr;
        }
    }
};

// Глобальный экземпляр
AudioCaptureWASAPI* g_audioCapture = nullptr;

// N-API функции
napi_value StartAudioCapture(napi_env env, napi_callback_info info) {
    if (!g_audioCapture) {
        g_audioCapture = new AudioCaptureWASAPI();
        if (!g_audioCapture->Initialize()) {
            napi_throw_error(env, nullptr, "Failed to initialize WASAPI");
            return nullptr;
        }
    }
    
    // TODO: Получить callback из JavaScript
    // g_audioCapture->StartCapture(callback);
    
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

napi_value StopAudioCapture(napi_env env, napi_callback_info info) {
    if (g_audioCapture) {
        g_audioCapture->StopCapture();
    }
    
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

// Инициализация модуля
napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"startAudioCapture", nullptr, StartAudioCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopAudioCapture", nullptr, StopAudioCapture, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)