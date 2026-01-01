# Интеграция SoundVolumeView для раздельного захвата аудио

## Обзор

Реализована интеграция SoundVolumeView для автоматического перенаправления звука конкретного приложения на VB-Cable при демонстрации экрана/окна в режиме Virtual Cable.

## Архитектура

```
[Игра] → [SoundVolumeView переключает выход на CABLE Input] → [VB-Cable] → [Electron захватывает с CABLE Output] → [Jitsi транслирует]
[Голоса участников] → [Обычные колонки] → НЕ попадают в захват
```

## Структура файлов

### Main Process

- `app/main/services/svvLocator.ts` - Локатор SoundVolumeView.exe
- `app/main/services/audioSessionService.ts` - Сервис для работы с аудио сессиями
- `app/main/ipc/audioHandlers.ts` - IPC обработчики

### Renderer Process

- `app/renderer/js/preload.ts` - Добавлен `window.audioApi` для доступа к API

### Интеграция

- `app/main/jitsi-vc-manager.ts` - Добавлены методы для перенаправления звука

## API

### Preload API (window.audioApi)

```typescript
// Проверить готовность
const { isReady } = await window.audioApi.checkReady();

// Получить список приложений со звуком
const { sessions } = await window.audioApi.getSessions();

// Получить список устройств
const { devices } = await window.audioApi.getDevices();

// Перенаправить звук приложения на VB-Cable
const { success } = await window.audioApi.routeToCable("game.exe");

// Восстановить звук приложения
const { success } = await window.audioApi.restoreDefault("game.exe");

// Установить путь к SoundVolumeView вручную
const { success } = await window.audioApi.setManualPath("C:\\path\\to\\SoundVolumeView.exe");

// Проверить наличие VB-Cable
const { hasVBCable } = await window.audioApi.hasVBCable();
```

## Использование

### 1. Проверка готовности

```javascript
const ready = await window.audioApi.checkReady();
if (!ready.isReady) {
    // Показать диалог настройки SVV
}
```

### 2. Получение списка приложений

```javascript
const result = await window.audioApi.getSessions();
const appsWithAudio = result.sessions; // Массив AudioSession
```

### 3. Перенаправление звука перед демонстрацией

```javascript
// При выборе окна для демонстрации
const processName = "game.exe"; // Из electronSourceId или выбора пользователя
await window.audioApi.routeToCable(processName);

// Затем создаем поток с Virtual Cable
// (уже реализовано в jitsi-vc-manager.ts)
```

### 4. Восстановление звука после демонстрации

```javascript
// Автоматически вызывается в cleanup()
// Или вручную:
await window.audioApi.restoreDefault(processName);
```

## IPC обработчики

Все обработчики регистрируются автоматически при запуске приложения через `registerAudioHandlers()` в `index.ts`.

## Автоматическое восстановление

При остановке демонстрации или закрытии окна Jitsi звук приложения автоматически восстанавливается на устройство по умолчанию через метод `cleanup()` в `jitsi-vc-manager.ts`.

## Требования

1. **SoundVolumeView** - должен быть установлен или указан путь вручную
2. **VB-Cable** - должен быть установлен как виртуальное аудиоустройство
3. **Windows** - работает только на Windows платформе

## Логирование

Все операции логируются через `electron-log` с префиксами:
- `[SVV]` - операции локатора SoundVolumeView
- `[AudioSession]` - операции с аудио сессиями
- `[AudioHandlers]` - IPC обработчики
- `[VC-MODE]` - операции перенаправления звука

