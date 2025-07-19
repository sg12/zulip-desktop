#include <node.h>
#include <uv.h>
#include <node_object_wrap.h>
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import "CaptureModule-Swift.h"
#include <map>

using namespace v8;

static CCaptureManager* g_manager = nullptr;

enum class CallbackType { SET_CAPTURE_SOURCE, START_CAPTURE, STOP_CAPTURE, SELECT_SOURCE };

struct CallbackInfo {
    Persistent<Promise::Resolver>* resolver;
    Isolate* isolate;
    std::string message;
    bool success;
    CallbackType type;
    std::map<std::string, std::string> sourceMap;
};

void AsyncCallback(uv_async_t* handle) {
    CallbackInfo* info = static_cast<CallbackInfo*>(handle->data);
    Isolate* isolate = info->isolate;
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    Local<Promise::Resolver> resolver = Local<Promise::Resolver>::New(isolate, *(info->resolver));

    if (info->success) {
        Local<Object> result = Object::New(isolate);
        if (info->type == CallbackType::SET_CAPTURE_SOURCE || info->type == CallbackType::SELECT_SOURCE) {
            for (const auto& pair : info->sourceMap) {
                result->Set(
                    context,
                    String::NewFromUtf8(isolate, pair.first.c_str()).ToLocalChecked(),
                    String::NewFromUtf8(isolate, pair.second.c_str()).ToLocalChecked()
                ).ToChecked();
            }
        } else {
            result->Set(
                context,
                String::NewFromUtf8(isolate, "message").ToLocalChecked(),
                String::NewFromUtf8(isolate, info->message.c_str()).ToLocalChecked()
            ).ToChecked();
        }
        resolver->Resolve(context, result).ToChecked();
    } else {
        resolver->Reject(context, String::NewFromUtf8(isolate, info->message.c_str()).ToLocalChecked()).ToChecked();
    }

    info->resolver->Reset();
    delete info->resolver;
    delete info;
    uv_close((uv_handle_t*)handle, [](uv_handle_t* handle) { delete handle; });
}

void TestMethod(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    [g_manager testMethod];
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Test completed from Swift").ToLocalChecked());
}

void SetCaptureSource(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    auto* persistent_resolver = new Persistent<Promise::Resolver>(isolate, resolver);

    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }

    if (args.Length() < 1 || !args[0]->IsObject()) {
        CallbackInfo* info = new CallbackInfo();
        info->isolate = isolate;
        info->resolver = persistent_resolver;
        info->message = "Invalid source object";
        info->success = false;
        info->type = CallbackType::SET_CAPTURE_SOURCE;
        uv_async_t* async = new uv_async_t;
        uv_async_init(uv_default_loop(), async, AsyncCallback);
        async->data = info;
        uv_async_send(async);
        return;
    }

    Local<Object> sourceObj = args[0]->ToObject(context).ToLocalChecked();
    Local<String> typeKey = String::NewFromUtf8(isolate, "type").ToLocalChecked();
    Local<String> idKey = String::NewFromUtf8(isolate, "id").ToLocalChecked();
    Local<String> nameKey = String::NewFromUtf8(isolate, "name").ToLocalChecked();

    v8::String::Utf8Value typeUtf(isolate, sourceObj->Get(context, typeKey).ToLocalChecked()->ToString(context).ToLocalChecked());
    v8::String::Utf8Value nameUtf(isolate, sourceObj->Get(context, nameKey).ToLocalChecked()->ToString(context).ToLocalChecked());

    NSString* typeStr = [NSString stringWithUTF8String:*typeUtf];
    NSNumber* idNum = @(sourceObj->Get(context, idKey).ToLocalChecked()->ToNumber(context).ToLocalChecked()->Int32Value(context).ToChecked());
    NSString* nameStr = [NSString stringWithUTF8String:*nameUtf];

    NSDictionary* sourceDict = @{
        @"type": typeStr,
        @"id": idNum,
        @"name": nameStr
    };

    [g_manager setCaptureSource:sourceDict completion:^(NSError* error) {
        CallbackInfo* info = new CallbackInfo();
        info->isolate = isolate;
        info->resolver = persistent_resolver;
        info->success = (error == nil);
        info->type = CallbackType::SET_CAPTURE_SOURCE;
        if (error) {
            info->message = [[error localizedDescription] UTF8String];
        } else {
            info->message = "Capture source set";
        }
        uv_async_t* async = new uv_async_t;
        uv_async_init(uv_default_loop(), async, AsyncCallback);
        async->data = info;
        uv_async_send(async);
    }];
}

void StartCapture(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    auto* persistent_resolver = new Persistent<Promise::Resolver>(isolate, resolver);
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    [g_manager startCaptureWithCompletion:^(NSError* error) {
        CallbackInfo* info = new CallbackInfo();
        info->isolate = isolate;
        info->resolver = persistent_resolver;
        info->success = (error == nil);
        info->type = CallbackType::START_CAPTURE;
        if (error) {
            info->message = [[error localizedDescription] UTF8String];
        } else {
            info->message = "Capture started";
        }
        uv_async_t* async = new uv_async_t;
        uv_async_init(uv_default_loop(), async, AsyncCallback);
        async->data = info;
        uv_async_send(async);
    }];
}

void StopCapture(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    auto* persistent_resolver = new Persistent<Promise::Resolver>(isolate, resolver);
    if (!g_manager) {
        CallbackInfo* info = new CallbackInfo();
        info->isolate = isolate;
        info->resolver = persistent_resolver;
        info->message = "Capture not started";
        info->success = false;
        info->type = CallbackType::STOP_CAPTURE;
        uv_async_t* async = new uv_async_t;
        uv_async_init(uv_default_loop(), async, AsyncCallback);
        async->data = info;
        uv_async_send(async);
        return;
    }
    [g_manager stopCaptureWithCompletion:^(NSError* error) {
        CallbackInfo* info = new CallbackInfo();
        info->isolate = isolate;
        info->resolver = persistent_resolver;
        info->success = (error == nil);
        info->type = CallbackType::STOP_CAPTURE;
        if (error) {
            info->message = [[error localizedDescription] UTF8String];
        } else {
            info->message = "Capture stopped";
        }
        uv_async_t* async = new uv_async_t;
        uv_async_init(uv_default_loop(), async, AsyncCallback);
        async->data = info;
        uv_async_send(async);
        g_manager = nullptr; // ARC manages memory
    }];
}

void SelectSourceWithPicker(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    auto* persistent_resolver = new Persistent<Promise::Resolver>(isolate, resolver);

    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }

    [g_manager selectSourceWithPickerWithCompletion:^(NSError* error, NSDictionary* source) {
        CallbackInfo* info = new CallbackInfo();
        info->isolate = isolate;
        info->resolver = persistent_resolver;
        info->success = (error == nil);
        info->type = CallbackType::SELECT_SOURCE;
        if (error) {
            info->message = [[error localizedDescription] UTF8String];
        } else {
            info->message = "Source selected";
            if (source) {
                NSString* type = source[@"type"];
                NSString* idStr = source[@"id"];
                info->sourceMap["type"] = [type UTF8String];
                info->sourceMap["id"] = [idStr UTF8String];
            }
        }
        uv_async_t* async = new uv_async_t;
        uv_async_init(uv_default_loop(), async, AsyncCallback);
        async->data = info;
        uv_async_send(async);
    }];
}

void Init(Local<Object> exports, Local<Value> module, void* context) {
    NODE_SET_METHOD(exports, "testMethod", TestMethod);
    NODE_SET_METHOD(exports, "setCaptureSource", SetCaptureSource);
    NODE_SET_METHOD(exports, "startCapture", StartCapture);
    NODE_SET_METHOD(exports, "stopCapture", StopCapture);
    NODE_SET_METHOD(exports, "selectSourceWithPicker", SelectSourceWithPicker);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
