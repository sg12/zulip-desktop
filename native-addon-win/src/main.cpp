#include <napi.h>
#include "capture_manager.h"

// Простые функции вместо класса
Napi::Value TestMethod(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::String::New(env, "Hello from Windows module!");
}

Napi::Value GetAvailableSources(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    Napi::Array sources = Napi::Array::New(env, 2);
    
    Napi::Object source1 = Napi::Object::New(env);
    source1.Set("type", "display");
    source1.Set("id", "0");
    source1.Set("name", "Primary Monitor");
    sources.Set((uint32_t)0, source1);
    
    Napi::Object source2 = Napi::Object::New(env);
    source2.Set("type", "window");
    source2.Set("id", "1");
    source2.Set("name", "Test Window");
    sources.Set((uint32_t)1, source2);
    
    return sources;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("testMethod", Napi::Function::New(env, TestMethod));
    exports.Set("getAvailableSources", Napi::Function::New(env, GetAvailableSources));
    return exports;
}

NODE_API_MODULE(screen_capture_win, Init)