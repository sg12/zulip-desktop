{
  "targets": [
    {
      "target_name": "audio_capture_win",
      "sources": [ 
        "src/audio_capture_wasapi.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "libraries": [
        "-lole32.lib",
        "-lwinmm.lib",
        "-lksuser.lib"
      ],
      "defines": [ 
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "UNICODE",
        "_UNICODE"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 0
        }
      }
    }
  ]
}