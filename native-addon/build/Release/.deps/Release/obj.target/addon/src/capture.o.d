cmd_Release/obj.target/addon/src/capture.o := /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++ '-DNODE_GYP_MODULE_NAME=addon' '-DUSING_UV_SHARED=1' '-DUSING_V8_SHARED=1' '-DV8_DEPRECATION_WARNINGS=1' '-D_GLIBCXX_USE_CXX11_ABI=1' '-DELECTRON_ENSURE_CONFIG_GYPI' '-D_DARWIN_USE_64_BIT_INODE=1' '-D_LARGEFILE_SOURCE' '-D_FILE_OFFSET_BITS=64' '-DUSING_ELECTRON_CONFIG_GYPI' '-DV8_COMPRESS_POINTERS' '-DV8_COMPRESS_POINTERS_IN_ISOLATE_CAGE' '-DV8_31BIT_SMIS_ON_64BIT_ARCH' '-DV8_ENABLE_SANDBOX' '-DOPENSSL_NO_PINSHARED' '-DOPENSSL_THREADS' '-DOPENSSL_NO_ASM' '-DBUILDING_NODE_EXTENSION' -I/Users/sg12/.electron-gyp/32.3.0/include/node -I/Users/sg12/.electron-gyp/32.3.0/src -I/Users/sg12/.electron-gyp/32.3.0/deps/openssl/config -I/Users/sg12/.electron-gyp/32.3.0/deps/openssl/openssl/include -I/Users/sg12/.electron-gyp/32.3.0/deps/uv/include -I/Users/sg12/.electron-gyp/32.3.0/deps/zlib -I/Users/sg12/.electron-gyp/32.3.0/deps/v8/include -I/Users/sg12/zulip-desktop/native-addon/swift_build -I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include/c++/v1 -I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include -I../.  -O3 -gdwarf-2 -mmacosx-version-min=13.0 -arch x86_64 -Wall -Wendif-labels -W -Wno-unused-parameter -std=c++20 -stdlib=libc++ -fno-rtti -fno-exceptions -fno-strict-aliasing -x objective-c++ -std=c++20 -fobjc-arc -fobjc-arc-exceptions -stdlib=libc++ -mmacosx-version-min=13.0 -isysroot /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk -I/Users/sg12/zulip-desktop/native-addon/swift_build -I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include/c++/v1 -I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include -F/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks -v -Wno-nullability-completeness -Wno-availability -Wno-deprecated-declarations -fobjc-arc -MMD -MF ./Release/.deps/Release/obj.target/addon/src/capture.o.d.raw -c -o Release/obj.target/addon/src/capture.o ../src/capture.mm
Release/obj.target/addon/src/capture.o: ../src/capture.mm \
  /Users/sg12/.electron-gyp/32.3.0/include/node/node.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/cppgc/common.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8config.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-array-buffer.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-local-handle.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-handle-base.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-internal.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-object.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-maybe.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-persistent-handle.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-weak-callback-info.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-primitive.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-data.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-value.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-sandbox.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-traced-handle.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-container.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-context.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-snapshot.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-isolate.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-callbacks.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-promise.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-debug.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-script.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-memory-span.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-message.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-embedder-heap.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-exception.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-function-callback.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-microtask.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-statistics.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-unwinder.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-embedder-state-scope.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-date.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-extension.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-external.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-function.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-template.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-initialization.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-platform.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-source-location.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-json.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-locker.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-microtask-queue.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-primitive-object.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-proxy.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-regexp.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-typed-array.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-value-serializer.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-version.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/v8-wasm.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/node_version.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/node_api.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/js_native_api.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/js_native_api_types.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/node_api_types.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/uv.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/uv/errno.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/uv/version.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/uv/unix.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/uv/threadpool.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/uv/darwin.h \
  /Users/sg12/.electron-gyp/32.3.0/include/node/node_object_wrap.h \
  /Users/sg12/zulip-desktop/native-addon/swift_build/CaptureModule-Swift.h
../src/capture.mm:
/Users/sg12/.electron-gyp/32.3.0/include/node/node.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/cppgc/common.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8config.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-array-buffer.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-local-handle.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-handle-base.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-internal.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-object.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-maybe.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-persistent-handle.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-weak-callback-info.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-primitive.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-data.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-value.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-sandbox.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-traced-handle.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-container.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-context.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-snapshot.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-isolate.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-callbacks.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-promise.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-debug.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-script.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-memory-span.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-message.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-embedder-heap.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-exception.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-function-callback.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-microtask.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-statistics.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-unwinder.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-embedder-state-scope.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-date.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-extension.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-external.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-function.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-template.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-initialization.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-platform.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-source-location.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-json.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-locker.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-microtask-queue.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-primitive-object.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-proxy.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-regexp.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-typed-array.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-value-serializer.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-version.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/v8-wasm.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/node_version.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/node_api.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/js_native_api.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/js_native_api_types.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/node_api_types.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/uv.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/uv/errno.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/uv/version.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/uv/unix.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/uv/threadpool.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/uv/darwin.h:
/Users/sg12/.electron-gyp/32.3.0/include/node/node_object_wrap.h:
/Users/sg12/zulip-desktop/native-addon/swift_build/CaptureModule-Swift.h:
