#ifndef NODE_API_H
#define NODE_API_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef _WIN32
  #define NAPI_EXTERN __declspec(dllexport)
#else
  #define NAPI_EXTERN __attribute__((visibility("default")))
#endif

// Основные типы
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

typedef enum {
  napi_default = 0,
  napi_writable = 1 << 0,
  napi_enumerable = 1 << 1,
  napi_configurable = 1 << 2,
} napi_property_attributes;

typedef struct {
  const char* utf8name;
  napi_value name;
  napi_callback method;
  napi_callback getter;
  napi_callback setter;
  napi_value value;
  napi_property_attributes attributes;
  void* data;
} napi_property_descriptor;

// Определяем NAPI_AUTO_LENGTH
#define NAPI_AUTO_LENGTH SIZE_MAX

// API функции (упрощенные декларации для компиляции)
#ifdef __cplusplus
extern "C" {
#endif

NAPI_EXTERN napi_value napi_create_string_utf8(napi_env env, const char* str, size_t length, napi_value* result);
NAPI_EXTERN napi_value napi_create_object(napi_env env, napi_value* result);
NAPI_EXTERN napi_value napi_create_array_with_length(napi_env env, size_t length, napi_value* result);
NAPI_EXTERN napi_value napi_set_named_property(napi_env env, napi_value object, const char* utf8name, napi_value value);
NAPI_EXTERN napi_value napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value);
NAPI_EXTERN napi_value napi_get_boolean(napi_env env, bool value, napi_value* result);
NAPI_EXTERN napi_value napi_define_properties(napi_env env, napi_value object, size_t property_count, const napi_property_descriptor* properties);

#ifdef __cplusplus
}
#endif

// Макрос для регистрации модуля
#define NAPI_MODULE(modname, regfunc)                                 \
  NAPI_EXTERN void napi_module_register(napi_value exports,           \
                                        napi_value module,             \
                                        napi_env env,                  \
                                        void* priv) {                  \
    regfunc(env, exports);                                             \
  }

#endif // NODE_API_H