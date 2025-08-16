{
  "targets": [
    {
      "target_name": "screen_capture_webrtc",
      "sources": [
        "src/webrtc_wrapper.mm",
        "src/ScreenCaptureManager.swift"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_CFLAGS": [
          "-fobjc-arc"
        ],
        "OTHER_CPLUSPLUSFLAGS": [
          "-std=c++20",
          "-fobjc-arc"
        ]
      },
      "link_settings": {
        "libraries": [
          "-framework Foundation",
          "-framework CoreMedia", 
          "-framework AVFoundation",
          "-framework ScreenCaptureKit",
          "-framework CoreVideo"
        ]
      }
    }
  ]
}
