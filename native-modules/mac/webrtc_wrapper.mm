#include <node.h>
#include <uv.h>
#include <node_object_wrap.h>
#include <memory>
#include <vector>
#include <map>        // Добавьте этот include для std::map
#include <string>     // Добавьте для std::string
#include <chrono>     // Добавьте для std::chrono
#include <atomic>     // Добавьте для std::atomic
#include <string.h>  // Для memcpy
#include <stdlib.h>  // Для malloc/free
#include <math.h>  // Для fmod

// Include Foundation and other frameworks first
#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <AVFoundation/AVFoundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>

// Include the generated Swift header as Objective-C
#import "CaptureModule-Swift.h"

using namespace v8;

static CCaptureManager* g_manager = nullptr;

// Simple atomic counters
static std::atomic<uint64_t> g_video_frame_count{0};
static std::atomic<uint64_t> g_audio_frame_count{0};
static std::atomic<bool> g_capture_active{false};

// Global callback storage for frame forwarding - ONLY DEFINE ONCE HERE
static v8::Persistent<v8::Function> g_video_callback;
static v8::Persistent<v8::Function> g_audio_callback;

// Структура для хранения информации о потоке
struct StreamInfo {
    std::string streamId;
    bool hasVideo;
    bool hasAudio;
    int width;
    int height;
    double frameRate;
    int sampleRate;
    int channels;
};

struct WorkData {
    uv_work_t request;
    Persistent<Promise::Resolver> resolver;
    Isolate* isolate;
    std::string operation;
    std::string message;
    std::string type;
    std::string id;
    bool success;
    NSError* error;
    NSDictionary* sourceDict;
    
    WorkData() : success(false), error(nil), sourceDict(nil) {
        request.data = this;
    }
    
    ~WorkData() {
        resolver.Reset();
        error = nil;
        sourceDict = nil;
    }
};

static std::map<std::string, StreamInfo> g_active_streams;


void WorkAsync(uv_work_t* req) {
    NSLog(@"[DEBUG] WorkAsync started");
    
    @autoreleasepool {
        WorkData* data = static_cast<WorkData*>(req->data);
        
        if (!data) {
            NSLog(@"[ERROR] WorkData is null in WorkAsync");
            return;
        }
        
        NSLog(@"[DEBUG] WorkAsync operation: %s", data->operation.c_str());
        
        if (!g_manager) {
            NSLog(@"[DEBUG] Creating g_manager in WorkAsync");
            @try {
                g_manager = [[CCaptureManager alloc] init];
                NSLog(@"[DEBUG] g_manager created in WorkAsync");
            } @catch (NSException *exception) {
                NSLog(@"[ERROR] Exception creating g_manager: %@", exception.reason);
                data->success = false;
                data->message = "Failed to create capture manager";
                return;
            }
        }
        
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        
        if (data->operation == "setCaptureSource") {
            NSLog(@"[DEBUG] Processing setCaptureSource");
            NSLog(@"[DEBUG] Type: %s, ID: %s", data->type.c_str(), data->id.c_str());
            
            @try {
                NSString* typeStr = [NSString stringWithUTF8String:data->type.c_str()];
                NSString* idStr = [NSString stringWithUTF8String:data->id.c_str()];
                
                NSDictionary* source = @{
                    @"type": typeStr,
                    @"id": idStr
                };
                
                NSLog(@"[DEBUG] Created source dictionary: %@", source);
                NSLog(@"[DEBUG] Calling setCaptureSource on g_manager");
                
                [g_manager setCaptureSource:source completion:^(NSError* error) {
                    NSLog(@"[DEBUG] setCaptureSource completion called");
                    if (error) {
                        NSLog(@"[ERROR] setCaptureSource error: %@", error.localizedDescription);
                        data->error = error;
                        data->success = false;
                        data->message = [[error localizedDescription] UTF8String];
                    } else {
                        NSLog(@"[DEBUG] setCaptureSource succeeded");
                        data->success = true;
                        data->message = "Capture source set";
                    }
                    dispatch_semaphore_signal(semaphore);
                }];
                
                NSLog(@"[DEBUG] Waiting for completion...");
                
            } @catch (NSException *exception) {
                NSLog(@"[ERROR] Exception in setCaptureSource: %@ - %@", exception.name, exception.reason);
                data->success = false;
                data->message = [[exception reason] UTF8String];
                dispatch_semaphore_signal(semaphore);
            }
            
        } else if (data->operation == "startCapture") {
            NSLog(@"[DEBUG] Processing startCapture");
            
            @try {
                [g_manager startCaptureWithCompletion:^(NSError* error) {
                    NSLog(@"[DEBUG] startCapture completion called");
                    if (error) {
                        NSLog(@"[ERROR] startCapture error: %@", error.localizedDescription);
                        data->error = error;
                        data->success = false;
                        data->message = [[error localizedDescription] UTF8String];
                    } else {
                        NSLog(@"[DEBUG] startCapture succeeded");
                        data->success = true;
                        data->message = "Capture started";
                        g_capture_active.store(true);
                    }
                    dispatch_semaphore_signal(semaphore);
                }];
                
                NSLog(@"[DEBUG] Waiting for startCapture completion...");
                
            } @catch (NSException *exception) {
                NSLog(@"[ERROR] Exception in startCapture: %@ - %@", exception.name, exception.reason);
                data->success = false;
                data->message = [[exception reason] UTF8String];
                dispatch_semaphore_signal(semaphore);
            }
            
        } else if (data->operation == "stopCapture") {
            g_capture_active.store(false);
            [g_manager stopCaptureWithCompletion:^(NSError* error) {
                if (error) {
                    data->error = error;
                    data->success = false;
                    data->message = [[error localizedDescription] UTF8String];
                } else {
                    data->success = true;
                    data->message = "Capture stopped";
                }
                dispatch_semaphore_signal(semaphore);
            }];
        }
        
        // Разный таймаут для разных операций
        dispatch_time_t timeout;
        if (data->operation == "startCapture") {
            // Больше времени для startCapture - 15 секунд
            timeout = dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC);
            NSLog(@"[DEBUG] Using 15 second timeout for startCapture");
        } else {
            // Стандартный таймаут для других операций - 10 секунд
            timeout = dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC);
        }
        
        long result = dispatch_semaphore_wait(semaphore, timeout);
        
        if (result != 0) {
            NSLog(@"[ERROR] Operation timeout: %s", data->operation.c_str());
            data->success = false;
            data->message = "Operation timeout";
        } else {
            NSLog(@"[DEBUG] WorkAsync completed normally");
        }
    }
    
    NSLog(@"[DEBUG] WorkAsync ended");
}

void WorkAsyncComplete(uv_work_t* req, int status) {
    std::unique_ptr<WorkData> data(static_cast<WorkData*>(req->data));
    
    Isolate* isolate = data->isolate;
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    
    Local<Promise::Resolver> resolver = Local<Promise::Resolver>::New(isolate, data->resolver);
    
    if (data->success && status == 0) {
        Local<Object> result = Object::New(isolate);
        result->Set(context,
            String::NewFromUtf8(isolate, "message").ToLocalChecked(),
            String::NewFromUtf8(isolate, data->message.c_str()).ToLocalChecked()).ToChecked();
        
        if (data->sourceDict) {
            NSString* type = data->sourceDict[@"type"];
            NSString* idStr = data->sourceDict[@"id"];
            if (type) {
                result->Set(context,
                    String::NewFromUtf8(isolate, "type").ToLocalChecked(),
                    String::NewFromUtf8(isolate, [type UTF8String]).ToLocalChecked()).ToChecked();
            }
            if (idStr) {
                result->Set(context,
                    String::NewFromUtf8(isolate, "id").ToLocalChecked(),
                    String::NewFromUtf8(isolate, [idStr UTF8String]).ToLocalChecked()).ToChecked();
            }
        }
        
        resolver->Resolve(context, result).ToChecked();
    } else {
        std::string errorMessage = data->message;
        if (data->error) {
            errorMessage = [[data->error localizedDescription] UTF8String];
        }
        resolver->Reject(context,
            String::NewFromUtf8(isolate, errorMessage.c_str()).ToLocalChecked()).ToChecked();
    }
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
    NSLog(@"[DEBUG] SetCaptureSource called - using simplified version");
    
    Isolate* isolate = args.GetIsolate();
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    // Используем дефолтные значения и не трогаем аргументы вообще
    std::string typeStr = "display";
    std::string idStr = "2077748985";  // Ваш display ID
    
    NSLog(@"[DEBUG] Using hardcoded values - type: '%s', id: '%s'", typeStr.c_str(), idStr.c_str());
    NSLog(@"[DEBUG] Note: Arguments parsing temporarily disabled to avoid crash");
    
    // Создаем менеджер если нужно
    if (!g_manager) {
        NSLog(@"[DEBUG] Creating CCaptureManager");
        g_manager = [[CCaptureManager alloc] init];
        NSLog(@"[DEBUG] CCaptureManager created");
    }
    
    // Создаем WorkData
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "setCaptureSource";
    data->type = typeStr;
    data->id = idStr;
    
    NSLog(@"[DEBUG] WorkData created, queueing work...");
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
    
    NSLog(@"[DEBUG] Work queued successfully");
}

// Альтернативная версия - используем только числовые параметры
void SetCaptureSourceById(const FunctionCallbackInfo<Value>& args) {
    NSLog(@"[DEBUG] SetCaptureSourceById called");
    
    Isolate* isolate = args.GetIsolate();
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    // Дефолтные значения
    int sourceType = 0;  // 0 = display, 1 = window
    int sourceId = 2077748985;
    
    // Пробуем получить числовые аргументы (они обычно безопаснее)
    if (args.Length() >= 2) {
        v8::TryCatch try_catch(isolate);
        
        // Первый аргумент - тип (число)
        if (!args[0].IsEmpty() && args[0]->IsNumber()) {
            sourceType = args[0]->Int32Value(context).ToChecked();
            NSLog(@"[DEBUG] Got source type: %d", sourceType);
        }
        
        // Второй аргумент - ID (число)
        if (!args[1].IsEmpty() && args[1]->IsNumber()) {
            sourceId = args[1]->Int32Value(context).ToChecked();
            NSLog(@"[DEBUG] Got source ID: %d", sourceId);
        }
        
        if (try_catch.HasCaught()) {
            NSLog(@"[WARNING] Exception getting numeric arguments, using defaults");
        }
    }
    
    // Конвертируем в строки
    std::string typeStr = (sourceType == 0) ? "display" : "window";
    std::string idStr = std::to_string(sourceId);
    
    NSLog(@"[DEBUG] Using type: '%s', id: '%s'", typeStr.c_str(), idStr.c_str());
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "setCaptureSource";
    data->type = typeStr;
    data->id = idStr;
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
    
    NSLog(@"[DEBUG] SetCaptureSourceById completed");
}


void SetCaptureSourceSimple(const FunctionCallbackInfo<Value>& args) {
    NSLog(@"[DEBUG] SetCaptureSourceSimple called");
    
    Isolate* isolate = args.GetIsolate();
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    // Expect two string arguments: type and id
    if (args.Length() < 2) {
        NSLog(@"[ERROR] Need 2 arguments");
        resolver->Reject(context, String::NewFromUtf8(isolate, "Need type and id arguments").ToLocalChecked()).ToChecked();
        return;
    }
    
    if (!args[0]->IsString() || !args[1]->IsString()) {
        NSLog(@"[ERROR] Arguments must be strings");
        resolver->Reject(context, String::NewFromUtf8(isolate, "Arguments must be strings").ToLocalChecked()).ToChecked();
        return;
    }
    
    // Direct string conversion
    String::Utf8Value typeUtf8(isolate, args[0]);
    String::Utf8Value idUtf8(isolate, args[1]);
    
    std::string typeStr(*typeUtf8);
    std::string idStr(*idUtf8);
    
    NSLog(@"[DEBUG] Got type='%s', id='%s'", typeStr.c_str(), idStr.c_str());
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "setCaptureSource";
    data->type = typeStr;
    data->id = idStr;
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
    
    NSLog(@"[DEBUG] Queued successfully");
}

void StartCapture(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "startCapture";
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

void StopCapture(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "stopCapture";
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

void StartAudioOnlyCapture(const FunctionCallbackInfo<Value>& args) {
    NSLog(@"🎵 StartAudioOnlyCapture called from JS");
    
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "startAudioOnlyCapture";
    
    uv_queue_work(uv_default_loop(), &data->request, 
        [](uv_work_t* req) {
            @autoreleasepool {
                WorkData* data = static_cast<WorkData*>(req->data);
                
                if (!g_manager) {
                    g_manager = [[CCaptureManager alloc] init];
                }
                
                dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
                
                [g_manager startAudioOnlyCapture:^(NSError* error) {
                    if (error) {
                        data->error = error;
                        data->success = false;
                        data->message = [[error localizedDescription] UTF8String];
                    } else {
                        data->success = true;
                        data->message = "Audio-only capture started";
                        g_capture_active.store(true);
                    }
                    dispatch_semaphore_signal(semaphore);
                }];
                
                dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
            }
        },
        WorkAsyncComplete
    );
}

void StartAudioVideoCapture(const FunctionCallbackInfo<Value>& args) {
    NSLog(@"📹🎵 StartAudioVideoCapture called from JS");
    
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "startAudioVideoCapture";
    
    uv_queue_work(uv_default_loop(), &data->request,
        [](uv_work_t* req) {
            @autoreleasepool {
                WorkData* data = static_cast<WorkData*>(req->data);
                
                if (!g_manager) {
                    g_manager = [[CCaptureManager alloc] init];
                }
                
                dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
                
                [g_manager startAudioVideoCapture:^(NSError* error) {
                    if (error) {
                        data->error = error;
                        data->success = false;
                        data->message = [[error localizedDescription] UTF8String];
                    } else {
                        data->success = true;
                        data->message = "Audio+Video capture started";
                        g_capture_active.store(true);
                    }
                    dispatch_semaphore_signal(semaphore);
                }];
                
                dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
            }
        },
        WorkAsyncComplete
    );
}

void SelectSourceWithPicker(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "selectSourceWithPicker";
    
    uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
}

// Функция для извлечения пикселей из CVImageBuffer
bool ExtractPixelsFromCVImageBuffer(CVImageBufferRef imageBuffer, uint8_t* destBuffer, size_t destSize) {
    if (!imageBuffer || !destBuffer) return false;
    
    // Блокируем буфер для чтения
    CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    
    // Получаем параметры изображения
    size_t width = CVPixelBufferGetWidth(imageBuffer);
    size_t height = CVPixelBufferGetHeight(imageBuffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer);
    OSType pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer);
    
    // Получаем указатель на данные
    void* baseAddress = CVPixelBufferGetBaseAddress(imageBuffer);
    
    bool success = false;
    
    if (baseAddress) {
        // Проверяем формат пикселей
        if (pixelFormat == kCVPixelFormatType_32BGRA) {
            // BGRA формат - самый распространенный
            size_t expectedSize = width * height * 4;
            
            if (destSize >= expectedSize) {
                // Копируем построчно (учитывая padding)
                uint8_t* src = (uint8_t*)baseAddress;
                uint8_t* dst = destBuffer;
                
                for (size_t y = 0; y < height; y++) {
                    memcpy(dst, src, width * 4);
                    src += bytesPerRow;
                    dst += width * 4;
                }
                
                success = true;
                NSLog(@"✅ Extracted %zu x %zu pixels in BGRA format", width, height);
            }
        } else if (pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
                   pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) {
            // YUV формат - нужна конвертация
            NSLog(@"⚠️ YUV format detected, conversion needed");
            // TODO: Добавить конвертацию YUV в BGRA
        } else {
            NSLog(@"⚠️ Unknown pixel format: %u", pixelFormat);
        }
    }
    
    // Разблокируем буфер
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    
    return success;
}

void SetWebRTCVideoCallback(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    
    NSLog(@"🎯 SetWebRTCVideoCallback called from JavaScript");
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    Local<Function> callback = Local<Function>::Cast(args[0]);
    Persistent<Function>* persistentCallback = new Persistent<Function>(isolate, callback);
    
    [g_manager setWebRTCVideoCallback:^(NSDictionary* frameData) {
        g_video_frame_count.fetch_add(1);
        
        // Извлекаем метаданные
        NSNumber* width = frameData[@"width"];
        NSNumber* height = frameData[@"height"];
        NSNumber* timestamp = frameData[@"timestamp"];
        NSNumber* dataSize = frameData[@"dataSize"];
        NSString* pixelFormatName = frameData[@"pixelFormatName"];
        
        int widthInt = width ? [width intValue] : 1920;
        int heightInt = height ? [height intValue] : 1080;
        int dataSizeInt = dataSize ? [dataSize intValue] : (widthInt * heightInt * 4);
        
        // НОВОЕ: Получаем пиксельные данные из NSData
        NSData* pixelData = frameData[@"pixelData"];
        bool hasRealPixels = (pixelData != nil && [pixelData length] > 0);
        
        if (hasRealPixels && g_video_frame_count.load() % 30 == 0) {
            NSLog(@"📹 Frame %llu: Got %lu bytes of pixel data (%dx%d, format: %@)", 
                  g_video_frame_count.load(), 
                  (unsigned long)[pixelData length],
                  widthInt, heightInt,
                  pixelFormatName ?: @"Unknown");
        }
        
        dispatch_async(dispatch_get_main_queue(), ^{
            Isolate* isolate = Isolate::GetCurrent();
            if (!isolate) return;
            
            HandleScope scope(isolate);
            Local<Context> context = isolate->GetCurrentContext();
            
            Local<Function> jsCallback = Local<Function>::New(isolate, *persistentCallback);
            Local<Object> videoInfo = Object::New(isolate);
            
            // Добавляем метаданные
            videoInfo->Set(context,
                String::NewFromUtf8(isolate, "width").ToLocalChecked(),
                Number::New(isolate, widthInt)).ToChecked();
            videoInfo->Set(context,
                String::NewFromUtf8(isolate, "height").ToLocalChecked(),
                Number::New(isolate, heightInt)).ToChecked();
            videoInfo->Set(context,
                String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                Number::New(isolate, timestamp ? [timestamp doubleValue] : 0)).ToChecked();
            
            // Создаем ArrayBuffer для пикселей
            size_t bufferSize = hasRealPixels ? [pixelData length] : dataSizeInt;
            Local<ArrayBuffer> pixelBuffer = ArrayBuffer::New(isolate, bufferSize);
            uint8_t* bufferData = static_cast<uint8_t*>(pixelBuffer->GetBackingStore()->Data());
            
            if (hasRealPixels && pixelData) {
                // Копируем реальные пиксели из NSData
                memcpy(bufferData, [pixelData bytes], [pixelData length]);
                
                if (g_video_frame_count.load() == 1) {
                    NSLog(@"✅ First frame with REAL pixels copied: %lu bytes", (unsigned long)[pixelData length]);
                    // Проверяем первые несколько пикселей
                    NSLog(@"  First pixels (BGRA): [%d,%d,%d,%d] [%d,%d,%d,%d]",
                          bufferData[0], bufferData[1], bufferData[2], bufferData[3],
                          bufferData[4], bufferData[5], bufferData[6], bufferData[7]);
                }
            } else {
                // Fallback: тестовый паттерн
                uint64_t frame = g_video_frame_count.load();
                
                for (int y = 0; y < heightInt; y++) {
                    for (int x = 0; x < widthInt; x++) {
                        int idx = (y * widthInt + x) * 4;
                        if (idx + 3 < bufferSize) {
                            bufferData[idx + 0] = (x * 255 / widthInt);     // B
                            bufferData[idx + 1] = (y * 255 / heightInt);     // G  
                            bufferData[idx + 2] = ((x + y) * 255 / (widthInt + heightInt)); // R
                            bufferData[idx + 3] = 255;                       // A
                        }
                    }
                }
                
                // Движущийся квадрат для визуализации
                int squareSize = 100;
                int squareX = (frame * 5) % (widthInt - squareSize);
                int squareY = (frame * 3) % (heightInt - squareSize);
                
                for (int y = squareY; y < squareY + squareSize && y < heightInt; y++) {
                    for (int x = squareX; x < squareX + squareSize && x < widthInt; x++) {
                        int idx = (y * widthInt + x) * 4;
                        if (idx + 3 < bufferSize) {
                            bufferData[idx + 0] = 255;  // B
                            bufferData[idx + 1] = 255;  // G
                            bufferData[idx + 2] = 0;    // R
                            bufferData[idx + 3] = 255;  // A
                        }
                    }
                }
                
                if (g_video_frame_count.load() % 100 == 0) {
                    NSLog(@"⚠️ Frame %llu: Using TEST pattern (no pixel data)", g_video_frame_count.load());
                }
            }
            
            videoInfo->Set(context,
                String::NewFromUtf8(isolate, "data").ToLocalChecked(),
                pixelBuffer).ToChecked();
            
            videoInfo->Set(context,
                String::NewFromUtf8(isolate, "hasRealPixels").ToLocalChecked(),
                v8::Boolean::New(isolate, hasRealPixels)).ToChecked();
            
            // Вызываем JavaScript callback
            Local<Value> argv[] = { videoInfo };
            
            v8::TryCatch try_catch(isolate);
            MaybeLocal<Value> result = jsCallback->Call(context, Null(isolate), 1, argv);
            
            if (try_catch.HasCaught()) {
                String::Utf8Value error(isolate, try_catch.Exception());
                NSLog(@"Error in video callback: %s", *error);
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "WebRTC video callback set").ToLocalChecked());
}

void TestBasicFunction(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    HandleScope scope(isolate);
    
    NSLog(@"[TEST] TestBasicFunction called");
    
    // Test 1: Return a simple string
    Local<String> result = String::NewFromUtf8(isolate, "Basic test passed", NewStringType::kNormal).ToLocalChecked();
    args.GetReturnValue().Set(result);
    
    NSLog(@"[TEST] TestBasicFunction completed");
}

// Вспомогательная функция для создания пустого буфера правильного размера
Local<ArrayBuffer> CreateAudioBuffer(Isolate* isolate, const AudioStreamBasicDescription& asbd, long numSamples) {
    // Рассчитываем размер буфера
    size_t bytesPerFrame = asbd.mBytesPerFrame;
    if (bytesPerFrame == 0) {
        // Если mBytesPerFrame не установлен, рассчитываем сами
        bytesPerFrame = (asbd.mBitsPerChannel / 8) * asbd.mChannelsPerFrame;
    }
    
    size_t totalBytes = numSamples * bytesPerFrame;
    
    NSLog(@"🎵 Creating audio buffer: %ld samples, %zu bytes per frame, %zu total bytes", 
          numSamples, bytesPerFrame, totalBytes);
    
    return ArrayBuffer::New(isolate, totalBytes);
}

// Полная функция SetWebRTCAudioCallback
void SetWebRTCAudioCallback(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    
    NSLog(@"🎯 SetWebRTCAudioCallback called from JavaScript");
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Проверяем, что передана функция
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Сохраняем JavaScript callback
    Local<Function> callback = Local<Function>::Cast(args[0]);
    Persistent<Function>* persistentCallback = new Persistent<Function>(isolate, callback);
    
    // Устанавливаем Objective-C callback который будет вызывать JavaScript
    [g_manager setWebRTCAudioCallback:^(CMSampleBufferRef sampleBuffer) {
        // Инкрементируем счетчик
        g_audio_frame_count.fetch_add(1);
        
        // Получаем данные о формате ДО dispatch_async
        CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
        AudioStreamBasicDescription asbd = {0};
        bool hasFormat = false;
        
        if (formatDesc) {
            const AudioStreamBasicDescription* asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
            if (asbdPtr) {
                asbd = *asbdPtr;
                hasFormat = true;
            }
        }
        
        // Получаем данные ДО dispatch_async
        long numSamples = CMSampleBufferGetNumSamples(sampleBuffer);
        uint64_t frameNumber = g_audio_frame_count.load();
        
        // Проверяем наличие блока данных
        CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
        bool hasBlockBuffer = (blockBuffer != nullptr);
        
        // КРИТИЧНО: Определяем источник более надежно
        // SCStream (системный звук) имеет временные метки кратные 0.02 (50 FPS)
        // Микрофон имеет более случайные временные метки
        CMTime presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
        double timestamp = CMTimeGetSeconds(presentationTime);
        
        // Анализируем паттерн временных меток
        double timeValue = timestamp * 1000.0; // Переводим в миллисекунды
        double remainder = fmod(timeValue, 20.0); // Проверяем кратность 20ms
        
        // SCStream обычно выдает фреймы каждые 20ms (0.02s)
        bool isSystemAudio = (remainder < 1.0 || remainder > 19.0);
        
        // Дополнительная проверка: размер данных
        // Системный звук часто имеет размер 7680 байт (960 сэмплов * 2 канала * 4 байта)
        // Микрофон чаще имеет размер 2048 байт
        size_t dataSize = 0;
        if (blockBuffer) {
            size_t lengthAtOffset = 0;
            size_t totalLength = 0;
            
            OSStatus status = CMBlockBufferGetDataPointer(
                blockBuffer,
                0,
                &lengthAtOffset,
                &totalLength,
                nullptr
            );
            
            if (status == noErr) {
                dataSize = totalLength;
            }
        }
        
        // Уточняем определение источника по размеру
        if (dataSize == 7680) {
            isSystemAudio = true;
        } else if (dataSize == 2048) {
            isSystemAudio = false;
        }
        
        const char* sourceType = isSystemAudio ? "system" : "microphone";
        
        NSLog(@"🎵 Audio callback: frame %llu, time: %.6f, remainder: %.2f, size: %zu, source: %s", 
              g_audio_frame_count.load(), 
              timestamp,
              remainder,
              dataSize,
              sourceType);
        
        // Пытаемся извлечь данные сразу
        void* audioDataPtr = nullptr;
        size_t audioDataSize = 0;
        
        if (blockBuffer && dataSize > 0) {
            // Есть CMBlockBuffer - извлекаем данные
            size_t lengthAtOffset = 0;
            size_t totalLength = 0;
            char* dataPointer = nullptr;
            
            OSStatus status = CMBlockBufferGetDataPointer(
                blockBuffer,
                0,
                &lengthAtOffset,
                &totalLength,
                &dataPointer
            );
            
            if (status == noErr && dataPointer && totalLength > 0) {
                audioDataPtr = malloc(totalLength);
                memcpy(audioDataPtr, dataPointer, totalLength);
                audioDataSize = totalLength;
                NSLog(@"🎵 Copied audio data from %s: %zu bytes", sourceType, totalLength);
            }
        } else if (hasFormat && numSamples > 0) {
            // Нет CMBlockBuffer - создаем буфер с тишиной для системного звука
            size_t bytesPerFrame = asbd.mBytesPerFrame;
            if (bytesPerFrame == 0) {
                bytesPerFrame = (asbd.mBitsPerChannel / 8) * asbd.mChannelsPerFrame;
            }
            
            audioDataSize = numSamples * bytesPerFrame;
            audioDataPtr = calloc(1, audioDataSize); // calloc инициализирует нулями
            NSLog(@"🎵 Created silent buffer for %s: %ld samples, %zu bytes", 
                  sourceType, numSamples, audioDataSize);
        }
        
        // Сохраняем определенный источник для использования в dispatch_async
        bool isMicrophoneSource = !isSystemAudio;
        
        // Вызываем JavaScript callback из главного потока
        dispatch_async(dispatch_get_main_queue(), ^{
            Isolate* isolate = Isolate::GetCurrent();
            if (!isolate) {
                if (audioDataPtr) free(audioDataPtr);
                return;
            }
            
            HandleScope scope(isolate);
            Local<Context> context = isolate->GetCurrentContext();
            
            // Получаем сохраненный callback
            Local<Function> jsCallback = Local<Function>::New(isolate, *persistentCallback);
            
            // Создаем объект с информацией об аудио
            Local<Object> audioInfo = Object::New(isolate);
            
            // Добавляем информацию о формате если есть
            if (hasFormat) {
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked(),
                    Number::New(isolate, asbd.mSampleRate)).ToChecked();
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "channels").ToLocalChecked(),
                    Number::New(isolate, asbd.mChannelsPerFrame)).ToChecked();
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "bitsPerChannel").ToLocalChecked(),
                    Number::New(isolate, asbd.mBitsPerChannel)).ToChecked();
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "formatID").ToLocalChecked(),
                    Number::New(isolate, asbd.mFormatID)).ToChecked();
            }
            
            // Добавляем основные данные
            audioInfo->Set(context,
                String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                Number::New(isolate, timestamp)).ToChecked();
            
            audioInfo->Set(context,
                String::NewFromUtf8(isolate, "numSamples").ToLocalChecked(),
                Number::New(isolate, numSamples)).ToChecked();
            
            audioInfo->Set(context,
                String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                Number::New(isolate, static_cast<double>(frameNumber))).ToChecked();
            
            // Добавляем аудио данные если есть
            if (audioDataPtr && audioDataSize > 0) {
                // Создаем ArrayBuffer и копируем данные
                Local<ArrayBuffer> arrayBuffer = ArrayBuffer::New(isolate, audioDataSize);
                void* bufferData = arrayBuffer->GetBackingStore()->Data();
                memcpy(bufferData, audioDataPtr, audioDataSize);
                
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "data").ToLocalChecked(),
                    arrayBuffer).ToChecked();
                
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "dataSize").ToLocalChecked(),
                    Number::New(isolate, static_cast<double>(audioDataSize))).ToChecked();
                
                // Указываем источник на основе анализа
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "source").ToLocalChecked(),
                    String::NewFromUtf8(isolate, isMicrophoneSource ? "microphone" : "system").ToLocalChecked()).ToChecked();
                
                // Добавляем дополнительную информацию для отладки
                audioInfo->Set(context,
                    String::NewFromUtf8(isolate, "hasBlockBuffer").ToLocalChecked(),
                    v8::Boolean::New(isolate, hasBlockBuffer)).ToChecked();
            }
            
            // Освобождаем память
            if (audioDataPtr) {
                free(audioDataPtr);
            }
            
            // Вызываем JavaScript callback
            Local<Value> argv[] = { audioInfo };
            
            v8::TryCatch try_catch(isolate);
            MaybeLocal<Value> result = jsCallback->Call(context, Null(isolate), 1, argv);
            
            if (try_catch.HasCaught()) {
                // Логируем ошибку но не крашимся
                String::Utf8Value error(isolate, try_catch.Exception());
                NSLog(@"Error in audio callback: %s", *error);
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "WebRTC audio callback set").ToLocalChecked());
}

// Method to get current frame counts
void GetFrameStats(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    Local<Object> stats = Object::New(isolate);
    stats->Set(context,
        String::NewFromUtf8(isolate, "videoFrames").ToLocalChecked(),
        Number::New(isolate, static_cast<double>(g_video_frame_count.load()))).ToChecked();
    stats->Set(context,
        String::NewFromUtf8(isolate, "audioFrames").ToLocalChecked(),
        Number::New(isolate, static_cast<double>(g_audio_frame_count.load()))).ToChecked();
    stats->Set(context,
        String::NewFromUtf8(isolate, "isActive").ToLocalChecked(),
        v8::Boolean::New(isolate, g_capture_active.load())).ToChecked();
    
    args.GetReturnValue().Set(stats);
}

// Function to forward video frames to Electron
// Replace the problematic ForwardVideoFrame and ForwardAudioFrame functions in your webrtc_wrapper.mm
// Fix the V8 API calls

void ForwardVideoFrame(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Store the callback
    g_video_callback.Reset(isolate, args[0].As<Function>());
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Set up WebRTC video callback that forwards to JavaScript
    [g_manager setWebRTCVideoCallback:^(NSDictionary* frameData) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!g_video_callback.IsEmpty()) {
                Isolate* isolate = Isolate::GetCurrent();
                if (!isolate) return;
                
                HandleScope scope(isolate);
                Local<Context> context = isolate->GetCurrentContext();
                
                // Create JavaScript object from frame data
                Local<Object> jsFrameData = Object::New(isolate);
                
                NSNumber* width = frameData[@"width"];
                NSNumber* height = frameData[@"height"];
                NSNumber* timestamp = frameData[@"timestamp"];
                
                if (width) {
                    jsFrameData->Set(context,
                        String::NewFromUtf8(isolate, "width").ToLocalChecked(),
                        Number::New(isolate, [width doubleValue])).ToChecked();
                }
                if (height) {
                    jsFrameData->Set(context,
                        String::NewFromUtf8(isolate, "height").ToLocalChecked(),
                        Number::New(isolate, [height doubleValue])).ToChecked();
                }
                if (timestamp) {
                    jsFrameData->Set(context,
                        String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                        Number::New(isolate, [timestamp doubleValue])).ToChecked();
                }
                
                // Add frame counter
                g_video_frame_count.fetch_add(1);
                jsFrameData->Set(context,
                    String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                    Number::New(isolate, static_cast<double>(g_video_frame_count.load()))).ToChecked();
                
                // Call the JavaScript callback
                Local<Function> callback = Local<Function>::New(isolate, g_video_callback);
                Local<Value> argv[] = { jsFrameData };
                
                v8::TryCatch try_catch(isolate);
                MaybeLocal<Value> result = callback->Call(context, Null(isolate), 1, argv);
                if (try_catch.HasCaught() || result.IsEmpty()) {
                    // Silently ignore callback errors to prevent crashes
                }
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Video frame forwarding enabled").ToLocalChecked());
}

// Function to forward audio frames to Electron
void ForwardAudioFrame(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();

    NSLog(@"🎯 ForwardAudioFrame called from JavaScript");
    
    if (args.Length() < 1 || !args[0]->IsFunction()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected callback function").ToLocalChecked()));
        return;
    }
    
    // Store the callback
    g_audio_callback.Reset(isolate, args[0].As<Function>());
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Set up WebRTC audio callback that forwards to JavaScript
    [g_manager setWebRTCAudioCallback:^(CMSampleBufferRef sampleBuffer) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!g_audio_callback.IsEmpty()) {
                Isolate* isolate = Isolate::GetCurrent();
                if (!isolate) return;
                
                HandleScope scope(isolate);
                Local<Context> context = isolate->GetCurrentContext();
                
                // Create JavaScript object from audio data
                Local<Object> jsAudioData = Object::New(isolate);
                
                // Get audio format info
                CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
                if (formatDesc) {
                    const AudioStreamBasicDescription* asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
                    if (asbd) {
                        jsAudioData->Set(context,
                            String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked(),
                            Number::New(isolate, asbd->mSampleRate)).ToChecked();
                        jsAudioData->Set(context,
                            String::NewFromUtf8(isolate, "channels").ToLocalChecked(),
                            Number::New(isolate, asbd->mChannelsPerFrame)).ToChecked();
                    }
                }
                
                // Add timestamp
                CMTime presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
                double timestamp = CMTimeGetSeconds(presentationTime) * 1000.0; // Convert to milliseconds
                jsAudioData->Set(context,
                    String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
                    Number::New(isolate, timestamp)).ToChecked();
                
                // Add frame counter
                g_audio_frame_count.fetch_add(1);
                jsAudioData->Set(context,
                    String::NewFromUtf8(isolate, "frameNumber").ToLocalChecked(),
                    Number::New(isolate, static_cast<double>(g_audio_frame_count.load()))).ToChecked();
                
                // Call the JavaScript callback
                Local<Function> callback = Local<Function>::New(isolate, g_audio_callback);
                Local<Value> argv[] = { jsAudioData };
                
                v8::TryCatch try_catch(isolate);
                MaybeLocal<Value> result = callback->Call(context, Null(isolate), 1, argv);
                if (try_catch.HasCaught() || result.IsEmpty()) {
                    // Silently ignore callback errors to prevent crashes
                }
            }
        });
    }];
    
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Audio frame forwarding enabled").ToLocalChecked());
}

void GetAvailableSources(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto resolver = Promise::Resolver::New(context).ToLocalChecked();
    args.GetReturnValue().Set(resolver->GetPromise());
    
    // Создаем WorkData для асинхронной операции
    WorkData* data = new WorkData();
    data->isolate = isolate;
    data->resolver.Reset(isolate, resolver);
    data->operation = "getAvailableSources";
    
    uv_queue_work(uv_default_loop(), &data->request, 
        // Функция выполнения в рабочем потоке
        [](uv_work_t* req) {
            @autoreleasepool {
                WorkData* data = static_cast<WorkData*>(req->data);
                
                if (!g_manager) {
                    g_manager = [[CCaptureManager alloc] init];
                }
                
                dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
                __block NSArray<NSDictionary*>* sources = nil;
                __block NSError* error = nil;
                
                [g_manager getAvailableSourcesWithCompletion:^(NSError* err, NSArray<NSDictionary*>* sourcesArray) {
                    error = err;
                    sources = sourcesArray;
                    dispatch_semaphore_signal(semaphore);
                }];
                
                dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
                
                if (error) {
                    data->error = error;
                    data->success = false;
                } else if (sources) {
                    // Сохраняем источники в формате, который можем передать обратно
                    data->success = true;
                    data->sourceDict = @{@"sources": sources};
                }
            }
        },
        // Функция завершения в главном потоке
        [](uv_work_t* req, int status) {
            std::unique_ptr<WorkData> data(static_cast<WorkData*>(req->data));
            
            Isolate* isolate = data->isolate;
            HandleScope scope(isolate);
            Local<Context> context = isolate->GetCurrentContext();
            
            Local<Promise::Resolver> resolver = Local<Promise::Resolver>::New(isolate, data->resolver);
            
            if (data->success && status == 0) {
                NSArray<NSDictionary*>* sources = data->sourceDict[@"sources"];
                
                if (sources) {
                    // Конвертируем NSArray в JavaScript массив
                    Local<Array> jsArray = Array::New(isolate, (int)sources.count);
                    
                    for (NSUInteger i = 0; i < sources.count; i++) {
                        NSDictionary* source = sources[i];
                        Local<Object> jsSource = Object::New(isolate);
                        
                        // Конвертируем все поля из словаря
                        for (NSString* key in source) {
                            id value = source[key];
                            Local<String> jsKey = String::NewFromUtf8(isolate, [key UTF8String]).ToLocalChecked();
                            
                            if ([value isKindOfClass:[NSString class]]) {
                                jsSource->Set(context, jsKey,
                                    String::NewFromUtf8(isolate, [(NSString*)value UTF8String]).ToLocalChecked()).ToChecked();
                            } else if ([value isKindOfClass:[NSNumber class]]) {
                                jsSource->Set(context, jsKey,
                                    Number::New(isolate, [(NSNumber*)value doubleValue])).ToChecked();
                            }
                        }
                        
                        jsArray->Set(context, i, jsSource).ToChecked();
                    }
                    
                    resolver->Resolve(context, jsArray).ToChecked();
                } else {
                    resolver->Resolve(context, Array::New(isolate, 0)).ToChecked();
                }
            } else {
                std::string errorMessage = "Failed to get sources";
                if (data->error) {
                    errorMessage = [[data->error localizedDescription] UTF8String];
                }
                resolver->Reject(context,
                    String::NewFromUtf8(isolate, errorMessage.c_str()).ToLocalChecked()).ToChecked();
            }
        }
    );
}

// Функция для создания виртуального MediaStream ID
void CreateVirtualStream(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    if (args.Length() < 1 || !args[0]->IsObject()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected stream configuration object").ToLocalChecked()));
        return;
    }
    
    Local<Object> config = args[0]->ToObject(context).ToLocalChecked();
    
    // Генерируем уникальный ID для потока
    auto now = std::chrono::system_clock::now();
    auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    std::string streamId = "native-stream-" + std::to_string(timestamp);
    
    StreamInfo info;
    info.streamId = streamId;
    
    // Получаем параметры видео
    Local<Value> hasVideoVal = config->Get(context, String::NewFromUtf8(isolate, "hasVideo").ToLocalChecked()).ToLocalChecked();
    info.hasVideo = hasVideoVal->BooleanValue(isolate);
    
    if (info.hasVideo) {
        info.width = config->Get(context, String::NewFromUtf8(isolate, "width").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
        info.height = config->Get(context, String::NewFromUtf8(isolate, "height").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
        info.frameRate = config->Get(context, String::NewFromUtf8(isolate, "frameRate").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
    }
    
    // Получаем параметры аудио
    Local<Value> hasAudioVal = config->Get(context, String::NewFromUtf8(isolate, "hasAudio").ToLocalChecked()).ToLocalChecked();
    info.hasAudio = hasAudioVal->BooleanValue(isolate);
    
    if (info.hasAudio) {
        info.sampleRate = config->Get(context, String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
        info.channels = config->Get(context, String::NewFromUtf8(isolate, "channels").ToLocalChecked())
            .ToLocalChecked()->NumberValue(context).ToChecked();
    }
    
    // Сохраняем информацию о потоке
    g_active_streams[streamId] = info;
    
    // Настраиваем прямые callbacks для этого потока
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    // Возвращаем ID потока
    Local<Object> result = Object::New(isolate);
    result->Set(context,
        String::NewFromUtf8(isolate, "streamId").ToLocalChecked(),
        String::NewFromUtf8(isolate, streamId.c_str()).ToLocalChecked()).ToChecked();
    result->Set(context,
        String::NewFromUtf8(isolate, "hasVideo").ToLocalChecked(),
        v8::Boolean::New(isolate, info.hasVideo)).ToChecked();  // Используем v8::Boolean
    result->Set(context,
        String::NewFromUtf8(isolate, "hasAudio").ToLocalChecked(),
        v8::Boolean::New(isolate, info.hasAudio)).ToChecked();  // Используем v8::Boolean
    
    args.GetReturnValue().Set(result);
}

// Функция для получения видео фрейма в формате, пригодном для WebRTC
void GetVideoFrameData(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    // Эта функция будет вызываться из JavaScript для получения последнего видео фрейма
    // В реальной реализации здесь нужно будет:
    // 1. Получить CVImageBuffer из последнего фрейма
    // 2. Конвертировать в RGB/YUV формат
    // 3. Передать как ArrayBuffer в JavaScript
    
    Local<Object> frameInfo = Object::New(isolate);
    frameInfo->Set(context,
        String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
        Number::New(isolate, g_video_frame_count.load())).ToChecked();
    frameInfo->Set(context,
        String::NewFromUtf8(isolate, "width").ToLocalChecked(),
        Number::New(isolate, 1920)).ToChecked(); // Заглушка
    frameInfo->Set(context,
        String::NewFromUtf8(isolate, "height").ToLocalChecked(),
        Number::New(isolate, 1080)).ToChecked(); // Заглушка
    
    args.GetReturnValue().Set(frameInfo);
}

// Функция для получения аудио данных в формате PCM
void GetAudioFrameData(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    
    // Эта функция будет вызываться из JavaScript для получения аудио данных
    // В реальной реализации здесь нужно будет:
    // 1. Получить CMSampleBuffer из последнего аудио фрейма
    // 2. Извлечь PCM данные
    // 3. Передать как Float32Array в JavaScript
    
    Local<Object> audioInfo = Object::New(isolate);
    audioInfo->Set(context,
        String::NewFromUtf8(isolate, "timestamp").ToLocalChecked(),
        Number::New(isolate, g_audio_frame_count.load())).ToChecked();
    audioInfo->Set(context,
        String::NewFromUtf8(isolate, "sampleRate").ToLocalChecked(),
        Number::New(isolate, 48000)).ToChecked();
    audioInfo->Set(context,
        String::NewFromUtf8(isolate, "channels").ToLocalChecked(),
        Number::New(isolate, 2)).ToChecked();
    
    args.GetReturnValue().Set(audioInfo);
}

void SetCaptureQuality(const FunctionCallbackInfo<Value>& args) {
    NSLog(@"[DEBUG] SetCaptureQuality called");
    
    Isolate* isolate = args.GetIsolate();
    HandleScope scope(isolate);
    Local<Context> context = isolate->GetCurrentContext();
    
    if (args.Length() < 3 || !args[0]->IsNumber() || !args[1]->IsNumber() || !args[2]->IsNumber()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Expected 3 numbers: width, height, fps").ToLocalChecked()));
        return;
    }
    
    int width = args[0]->Int32Value(context).ToChecked();
    int height = args[1]->Int32Value(context).ToChecked();
    int fps = args[2]->Int32Value(context).ToChecked();
    
    NSLog(@"[DEBUG] Quality params: %dx%d @ %d fps", width, height, fps);
    
    if (!g_manager) {
        g_manager = [[CCaptureManager alloc] init];
    }
    
    @try {
        [g_manager setCaptureQuality:width height:height fps:fps];
        args.GetReturnValue().Set(String::NewFromUtf8(isolate, "Quality set").ToLocalChecked());
    } @catch (NSException *exception) {
        NSLog(@"[ERROR] Failed to set quality: %@", exception.reason);
        isolate->ThrowException(Exception::Error(
            String::NewFromUtf8(isolate, [[exception reason] UTF8String]).ToLocalChecked()));
    }
}

void SetCaptureSourceWithQuality(const FunctionCallbackInfo<Value>& args) {
    NSLog(@"[DEBUG-1] SetCaptureSourceWithQuality - Entry point");
    
    Isolate* isolate = args.GetIsolate();
    NSLog(@"[DEBUG-2] Got isolate: %p", isolate);
    
    HandleScope scope(isolate);
    NSLog(@"[DEBUG-3] HandleScope created");
    
    Local<Context> context = isolate->GetCurrentContext();
    NSLog(@"[DEBUG-4] Got context");
    
    Local<Promise::Resolver> resolver = Promise::Resolver::New(context).ToLocalChecked();
    NSLog(@"[DEBUG-5] Promise resolver created");
    
    args.GetReturnValue().Set(resolver->GetPromise());
    NSLog(@"[DEBUG-6] Promise set as return value");
    
    // Проверка количества аргументов
    int argCount = args.Length();
    NSLog(@"[DEBUG-7] Arguments count: %d", argCount);
    
    if (argCount < 5) {
        NSLog(@"[ERROR] Not enough arguments: %d", argCount);
        resolver->Reject(context,
            String::NewFromUtf8(isolate, "Need 5 arguments").ToLocalChecked()).ToChecked();
        return;
    }
    
    // Инициализация переменных с дефолтными значениями
    std::string typeStr = "display";
    std::string idStr = "1";
    int width = 1920;
    int height = 1080;
    int fps = 30;
    
    NSLog(@"[DEBUG-8] Starting safe argument extraction with TryCatch");
    
    // Оборачиваем ВСЁ в TryCatch
    v8::TryCatch try_catch(isolate);
    
    try {
        NSLog(@"[DEBUG-9] Attempting to access args array");
        
        // Получаем аргументы через индексы с проверкой
        for (int i = 0; i < argCount && i < 5; i++) {
            NSLog(@"[DEBUG-10] Processing argument %d", i);
            
            Local<Value> arg = args[i];
            
            if (arg.IsEmpty()) {
                NSLog(@"[WARNING] Argument %d is empty", i);
                continue;
            }
            
            switch (i) {
                case 0: // type (string)
                    NSLog(@"[DEBUG-11] Processing type argument");
                    if (arg->IsString()) {
                        String::Utf8Value str(isolate, arg);
                        if (*str != nullptr) {
                            typeStr = std::string(*str);
                            NSLog(@"[DEBUG-12] Type: %s", typeStr.c_str());
                        }
                    }
                    break;
                    
                case 1: // id (string)
                    NSLog(@"[DEBUG-13] Processing id argument");
                    if (arg->IsString()) {
                        String::Utf8Value str(isolate, arg);
                        if (*str != nullptr) {
                            idStr = std::string(*str);
                            NSLog(@"[DEBUG-14] ID: %s", idStr.c_str());
                        }
                    }
                    break;
                    
                case 2: // width (number)
                    NSLog(@"[DEBUG-15] Processing width argument");
                    if (arg->IsNumber()) {
                        width = arg->Int32Value(context).ToChecked();
                        NSLog(@"[DEBUG-16] Width: %d", width);
                    }
                    break;
                    
                case 3: // height (number)
                    NSLog(@"[DEBUG-17] Processing height argument");
                    if (arg->IsNumber()) {
                        height = arg->Int32Value(context).ToChecked();
                        NSLog(@"[DEBUG-18] Height: %d", height);
                    }
                    break;
                    
                case 4: // fps (number)
                    NSLog(@"[DEBUG-19] Processing fps argument");
                    if (arg->IsNumber()) {
                        fps = arg->Int32Value(context).ToChecked();
                        NSLog(@"[DEBUG-20] FPS: %d", fps);
                    }
                    break;
            }
        }
        
    } catch (const std::exception& e) {
        NSLog(@"[ERROR] C++ exception during argument extraction: %s", e.what());
    } catch (...) {
        NSLog(@"[ERROR] Unknown exception during argument extraction");
    }
    
    // Проверяем, были ли V8 исключения
    if (try_catch.HasCaught()) {
        NSLog(@"[ERROR] V8 exception during argument extraction");
        Local<String> message = try_catch.Message()->Get();
        String::Utf8Value error(isolate, message);
        NSLog(@"[ERROR] V8 error: %s", *error);
        
        // Используем дефолтные значения и продолжаем
    }
    
    NSLog(@"[DEBUG-21] Parameters after extraction: type='%s', id='%s', %dx%d@%dfps", 
          typeStr.c_str(), idStr.c_str(), width, height, fps);
    
    // Проверка/создание менеджера
    NSLog(@"[DEBUG-22] Checking g_manager: %p", g_manager);
    
    if (!g_manager) {
        NSLog(@"[DEBUG-23] Creating CCaptureManager");
        @try {
            g_manager = [[CCaptureManager alloc] init];
            NSLog(@"[DEBUG-24] CCaptureManager created: %p", g_manager);
        } @catch (NSException *exception) {
            NSLog(@"[ERROR] Exception creating manager: %@", exception);
            resolver->Reject(context,
                String::NewFromUtf8(isolate, "Failed to create manager").ToLocalChecked()).ToChecked();
            return;
        }
    }
    
    // Пока пропускаем установку качества
    NSLog(@"[DEBUG-25] Skipping quality setting (commented out)");
    
    // Создание WorkData
    NSLog(@"[DEBUG-26] Creating WorkData");
    
    WorkData* data = nullptr;
    try {
        data = new WorkData();
        data->isolate = isolate;
        data->resolver.Reset(isolate, resolver);
        data->operation = "setCaptureSource";
        data->type = typeStr;
        data->id = idStr;
        NSLog(@"[DEBUG-27] WorkData created");
    } catch (...) {
        NSLog(@"[ERROR] Failed to create WorkData");
        if (data) delete data;
        resolver->Reject(context,
            String::NewFromUtf8(isolate, "Failed to create work data").ToLocalChecked()).ToChecked();
        return;
    }
    
    NSLog(@"[DEBUG-28] Queueing work");
    
    int result = uv_queue_work(uv_default_loop(), &data->request, WorkAsync, WorkAsyncComplete);
    
    NSLog(@"[DEBUG-29] uv_queue_work result: %d", result);
    
    if (result != 0) {
        NSLog(@"[ERROR] uv_queue_work failed");
        delete data;
        resolver->Reject(context,
            String::NewFromUtf8(isolate, "Failed to queue work").ToLocalChecked()).ToChecked();
        return;
    }
    
    NSLog(@"[DEBUG-30] SetCaptureSourceWithQuality completed successfully");
}

// Update your Init function to export the new methods
void Init(Local<Object> exports, Local<Value> module, void* context) {
    // Основные методы
    NODE_SET_METHOD(exports, "testMethod", TestMethod);
    NODE_SET_METHOD(exports, "testBasic", TestBasicFunction);
    
    // Единый метод для установки источника (поддерживает оба варианта вызова)
    NODE_SET_METHOD(exports, "setCaptureSource", SetCaptureSource);
    // Для обратной совместимости оставляем алиас
    NODE_SET_METHOD(exports, "setCaptureSourceSimple", SetCaptureSource);
    
    // Методы для управления качеством
    NODE_SET_METHOD(exports, "setCaptureQuality", SetCaptureQuality);
    NODE_SET_METHOD(exports, "setCaptureSourceWithQuality", SetCaptureSourceWithQuality);

    // Новые методы для разных режимов захвата
    NODE_SET_METHOD(exports, "startAudioOnlyCapture", StartAudioOnlyCapture);
    NODE_SET_METHOD(exports, "startAudioVideoCapture", StartAudioVideoCapture);
    
    // Остальные методы
    NODE_SET_METHOD(exports, "startCapture", StartCapture);
    NODE_SET_METHOD(exports, "stopCapture", StopCapture);
    NODE_SET_METHOD(exports, "setWebRTCVideoCallback", SetWebRTCVideoCallback);
    NODE_SET_METHOD(exports, "setWebRTCAudioCallback", SetWebRTCAudioCallback);
    NODE_SET_METHOD(exports, "getFrameStats", GetFrameStats);
    NODE_SET_METHOD(exports, "forwardVideoFrame", ForwardVideoFrame);
    NODE_SET_METHOD(exports, "forwardAudioFrame", ForwardAudioFrame);
    NODE_SET_METHOD(exports, "getAvailableSources", GetAvailableSources);
    NODE_SET_METHOD(exports, "selectSourceWithPicker", SelectSourceWithPicker);
    
    // Методы для MediaStream
    NODE_SET_METHOD(exports, "createVirtualStream", CreateVirtualStream);
    NODE_SET_METHOD(exports, "getVideoFrameData", GetVideoFrameData);
    NODE_SET_METHOD(exports, "getAudioFrameData", GetAudioFrameData);

    NODE_SET_METHOD(exports, "setCaptureSourceById", SetCaptureSourceById);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
