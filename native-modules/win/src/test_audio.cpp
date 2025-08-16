#include <node_api.h>
#include <windows.h>
#include <cmath>
#include <thread>

// Генератор тестового синусоидального сигнала
class TestAudioGenerator {
private:
    std::thread generatorThread;
    bool isRunning = false;
    napi_threadsafe_function jsCallback = nullptr;
    float phase = 0.0f;
    
public:
    void Start(napi_threadsafe_function callback) {
        if (isRunning) return;
        
        jsCallback = callback;
        isRunning = true;
        
        generatorThread = std::thread([this]() {
            while (isRunning) {
                GenerateAudioFrame();
                Sleep(20); // 50 FPS
            }
        });
    }
    
    void GenerateAudioFrame() {
        const int sampleRate = 48000;
        const int channels = 2;
        const int samplesPerFrame = 960; // 20ms at 48kHz
        const float frequency = 440.0f; // A4 note
        
        float* samples = new float[samplesPerFrame * channels];
        
        // Генерируем синусоиду
        for (int i = 0; i < samplesPerFrame; i++) {
            float sample = sin(phase) * 0.3f; // 30% громкости
            samples[i * 2] = sample;     // Left
            samples[i * 2 + 1] = sample; // Right
            
            phase += 2.0f * 3.14159f * frequency / sampleRate;
            if (phase > 2.0f * 3.14159f) {
                phase -= 2.0f * 3.14159f;
            }
        }
        
        // Отправляем в JavaScript
        if (jsCallback) {
            struct AudioData {
                float* data;
                int samples;
                int channels;
                int sampleRate;
            } audioData = { samples, samplesPerFrame, channels, sampleRate };
            
            napi_call_threadsafe_function(jsCallback, &audioData, napi_tsfn_blocking);
        }
        
        delete[] samples;
    }
    
    void Stop() {
        isRunning = false;
        if (generatorThread.joinable()) {
            generatorThread.join();
        }
    }
};

TestAudioGenerator* g_generator = nullptr;

// Экспортируемые функции
napi_value TestMethod(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, "Windows REAL Audio Module v1.0 (Test Generator)", NAPI_AUTO_LENGTH, &result);
    return result;
}

napi_value StartCapture(napi_env env, napi_callback_info info) {
    // Здесь должна быть реализация с callback
    if (!g_generator) {
        g_generator = new TestAudioGenerator();
    }
    
    // TODO: Получить callback и передать в Start
    
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

napi_value StopCapture(napi_env env, napi_callback_info info) {
    if (g_generator) {
        g_generator->Stop();
        delete g_generator;
        g_generator = nullptr;
    }
    
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"testMethod", nullptr, TestMethod, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startCapture", nullptr, StartCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopCapture", nullptr, StopCapture, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)