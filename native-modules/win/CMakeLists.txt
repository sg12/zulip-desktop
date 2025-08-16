cmake_minimum_required(VERSION 3.20)
project(screen_capture_win)

set(CMAKE_CXX_STANDARD 17)

# Node.js и N-API
include_directories(
    ${CMAKE_JS_INC}
    ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api
)

# Исходники
add_library(${PROJECT_NAME} SHARED
    src/main.cpp
    src/ScreenCapture.cpp
    src/AudioCapture.cpp
    ${CMAKE_JS_SRC}
)

# Библиотеки Windows
target_link_libraries(${PROJECT_NAME}
    ${CMAKE_JS_LIB}
    d3d11
    dxgi
    winmm
    ole32
    oleaut32
)

# Установка имени выходного файла
set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
)