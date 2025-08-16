#include <node_api.h>
#include <string>
#include <vector>

// Простая структура для источников
struct Source {
    std::string id;
    std::string name;
    std::string type;
};

// Mock данные
std::vector<Source> mockSources = {
    {"1", "Primary Display", "screen"},
    {"2", "Secondary Display", "screen"},
    {"1001", "Visual Studio Code", "window"},
    {"1002", "Chrome", "window"}
};

// Вспомогательная функция для создания строки
napi_value CreateString(napi_env env, const char* str) {
    napi_value result;
    napi_create_string_utf8(env, str, NAPI_AUTO_LENGTH, &result);
    return result;
}

// testMethod
napi_value TestMethod(napi_env env, napi_callback_info info) {
    return CreateString(env, "Windows Native Module (Zig-compiled) v1.0");
}

// getAvailableSources
napi_value GetAvailableSources(napi_env env, napi_callback_info info) {
    napi_value array;
    napi_create_array_with_length(env, mockSources.size(), &array);
    
    for (size_t i = 0; i < mockSources.size(); i++) {
        napi_value obj;
        napi_create_object(env, &obj);
        
        napi_value id = CreateString(env, mockSources[i].id.c_str());
        napi_value name = CreateString(env, mockSources[i].name.c_str());
        napi_value type = CreateString(env, mockSources[i].type.c_str());
        
        napi_set_named_property(env, obj, "id", id);
        napi_set_named_property(env, obj, "name", name);
        napi_set_named_property(env, obj, "type", type);
        
        napi_set_element(env, array, i, obj);
    }
    
    return array;
}

// startCapture
napi_value StartCapture(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// stopCapture
napi_value StopCapture(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// setCaptureQuality
napi_value SetCaptureQuality(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// setCaptureSource
napi_value SetCaptureSource(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_object(env, &result);
    
    napi_value success;
    napi_get_boolean(env, true, &success);
    napi_set_named_property(env, result, "success", success);
    
    return result;
}

// setWebRTCVideoCallback - заглушка
napi_value SetWebRTCVideoCallback(napi_env env, napi_callback_info info) {
    // Просто сохраняем callback, но не вызываем (заглушка)
    return nullptr;
}

// setWebRTCAudioCallback - заглушка
napi_value SetWebRTCAudioCallback(napi_env env, napi_callback_info info) {
    // Просто сохраняем callback, но не вызываем (заглушка)
    return nullptr;
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
        {"setWebRTCAudioCallback", nullptr, SetWebRTCAudioCallback, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)