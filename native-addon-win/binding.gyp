{
  "targets": [
    {
      "target_name": "screen_capture_win",
      "sources": [
        "src/main.cpp",
        "src/capture_manager.cpp",
        "src/screen_capture.cpp", 
        "src/audio_capture.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
      'conditions': [
        ['OS=="win"', {
          'libraries': [
            '-lole32',
            '-loleaut32', 
            '-ld3d11',
            '-ldxgi',
            '-lwindowsapp',
            '-lmmdevapi',
            '-laudioclient',
            '-lavrt'
          ],
          'msvs_settings': {
            'VCCLCompilerTool': {
              'AdditionalOptions': [ '/std:c++17' ]
            }
          }
        }],
        ['OS=="mac"', {
          # Для кросс-компиляции на Mac
          'cflags': [
            '-std=c++17',
            '-target', 'x86_64-w64-mingw32'
          ],
          'ldflags': [
            '-target', 'x86_64-w64-mingw32',
            '-static-libgcc',
            '-static-libstdc++'
          ]
        }]
      ]
    }
  ]
}