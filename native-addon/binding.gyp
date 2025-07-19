{
  "targets": [
    {
      "target_name": "addon",
      "sources": ["src/capture.mm"],
      "include_dirs": [
        "<(module_root_dir)/swift_build",
        "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include/c++/v1",
        "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include",
        "<!(node -e \"require('node-addon-api').include_dir\")"
      ],
      "libraries": [
        "<(module_root_dir)/swift_build/libscreen.a",
        "-framework Foundation",
        "-framework AVFoundation",
        "-framework ScreenCaptureKit",
        "-framework VideoToolbox",
        "-framework AppKit",
        "-framework CoreMedia",
        "-framework CoreVideo",
        "-framework AudioToolbox"
      ],
      "cflags_cc": [
        "-x objective-c++",
        "-std=c++20",
        "-fobjc-arc",
        "-fobjc-arc-exceptions",
        "-stdlib=libc++",
        "-mmacosx-version-min=13.0",
        "-isysroot /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk",
        "-I<(module_root_dir)/swift_build",
        "-I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include/c++/v1",
        "-I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include",
        "-F/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks",
        "-v",
        "-Wno-nullability-completeness",
        "-Wno-availability",
        "-Wno-deprecated-declarations"
      ],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_LDFLAGS": [
          "-framework Foundation",
          "-framework AVFoundation",
          "-framework ScreenCaptureKit",
          "-framework VideoToolbox",
          "-framework AppKit",
          "-framework CoreMedia",
          "-framework CoreVideo",
          "-framework AudioToolbox",
          "-isysroot /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk",
          "-L/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/lib/swift",
          "-lswiftCore",
          "-lswiftCoreFoundation",
          "-lswiftDarwin",
          "-lswiftFoundation",
          "-lswiftObjectiveC",
          "-rpath /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/lib/swift",
          "-Wl,-v"
        ],
        "OTHER_CFLAGS": [
          "-x objective-c++",
          "-std=c++20",
          "-fobjc-arc",
          "-fobjc-arc-exceptions",
          "-stdlib=libc++",
          "-mmacosx-version-min=13.0",
          "-isysroot /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk",
          "-I<(module_root_dir)/swift_build",
          "-I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include/c++/v1",
          "-I/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/usr/include",
          "-F/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk/System/Library/Frameworks",
          "-v",
          "-Wno-nullability-completeness",
          "-Wno-availability",
          "-Wno-deprecated-declarations"
        ],
        "HEADER_SEARCH_PATHS": [
          "$(inherited)",
          "<(module_root_dir)/swift_build"
        ],
        "SWIFT_VERSION": "6.0",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "GCC_PREPROCESSOR_DEFINITIONS": [
          "SWIFT_OBJC_INTEROP=1"
        ]
      },
      "actions": [
        {
          "action_name": "compile_swift",
          "inputs": [
            "src/ScreenCaptureManager.swift"
          ],
          "outputs": [
            "swift_build/CaptureModule.o",
            "swift_build/CaptureModule-Swift.h"
          ],
          "action": [
            "swiftc",
            "-c",
            "src/ScreenCaptureManager.swift",
            "-module-name",
            "CaptureModule",
            "-emit-objc-header",
            "-emit-objc-header-path",
            "swift_build/CaptureModule-Swift.h",
            "-emit-module",
            "-emit-module-path",
            "swift_build/CaptureModule.swiftmodule",
            "-sdk",
            "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk",
            "-F",
            "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks",
            "-framework",
            "Foundation",
            "-framework",
            "ScreenCaptureKit",
            "-framework",
            "AVFoundation",
            "-framework",
            "VideoToolbox",
            "-framework",
            "AppKit",
            "-framework",
            "CoreMedia",
            "-framework",
            "CoreVideo",
            "-framework",
            "AudioToolbox",
            "-target",
            "x86_64-apple-macos13.0",
            "-o",
            "swift_build/CaptureModule.o"
          ]
        },
        {
          "action_name": "archive_swift",
          "inputs": [
            "swift_build/CaptureModule.o"
          ],
          "outputs": [
            "swift_build/libscreen.a"
          ],
          "action": [
            "ar",
            "rcs",
            "swift_build/libscreen.a",
            "swift_build/CaptureModule.o"
          ]
        }
      ]
    }
  ]
}
