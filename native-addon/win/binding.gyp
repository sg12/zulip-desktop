{
  "targets": [{
    "target_name": "capture",
    "sources": [
      "src/main.cpp"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "src"
    ],
    "dependencies": [
      "<!(node -p \"require('node-addon-api').gyp\")"
    ],
    "conditions": [
      ["OS=='win'", {
        "defines": [
          "_HAS_EXCEPTIONS=1",
          "NAPI_CPP_EXCEPTIONS",
          "UNICODE",
          "_UNICODE",
          "WINVER=0x0A00",
          "_WIN32_WINNT=0x0A00",
          "NTDDI_VERSION=0x0A000000"
        ],
        "libraries": [
          "-ld3d11.lib",
          "-ldxgi.lib",
          "-lole32.lib",
          "-luser32.lib",
          "-ldwmapi.lib",
          "-lpsapi.lib",
          "-lwinmm.lib",
          "-lmmdevapi.lib",
          "-lpropsys.lib",
          "-lVersion.lib"  # Добавляем для VerifyVersionInfo
        ],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "ExceptionHandling": 1,
            "AdditionalOptions": [
              "/std:c++17",
              "/EHsc"
            ],
            "RuntimeLibrary": 2,
            "WarningLevel": 3,
            "DisableSpecificWarnings": ["4996", "4244", "4267"]
          },
          "VCLinkerTool": {
            "AdditionalOptions": [
              "/SUBSYSTEM:WINDOWS"
            ]
          }
        },
        "cflags_cc": [
          "/std:c++17",
          "/EHsc"
        ]
      }]
    ]
  }]
}