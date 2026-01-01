# Инструкция по настройке на Windows

## 📋 Обязательные требования

### 1. Системные зависимости

#### Node.js
- **Версия:** >= 18.x (проверено в `package.json`)
- **Скачать:** https://nodejs.org/
- **Проверка:** `node -v` в PowerShell/CMD

#### Python
- **Версия:** 3.x (рекомендуется 3.11)
- **Скачать:** https://www.python.org/downloads/
- **Важно:** При установке отметьте "Add Python to PATH"
- **Проверка:** `python --version`

#### Visual Studio Build Tools
- **Требуется для:** Компиляции нативного модуля `native-addon`
- **Скачать:** https://visualstudio.microsoft.com/downloads/
- **Выбрать:** "Build Tools for Visual Studio 2022"
- **При установке выбрать:**
  - ✅ Desktop development with C++
  - ✅ Windows 10/11 SDK (последняя версия)
  - ✅ MSVC v143 compiler toolset

**Альтернатива (быстрее):**
```powershell
# Открыть PowerShell как Администратор
npm install --global windows-build-tools
```

#### Git
- **Скачать:** https://git-scm.com/download/win
- **Проверка:** `git --version`

### 2. Аудио компоненты (для функции маршрутизации звука)

#### VB-Audio Virtual Cable
- **Скачать:** https://vb-audio.com/Cable/
- **Установка:** 
  1. Скачать `VBCABLE_Setup.exe`
  2. Запустить от имени администратора
  3. Установить с настройками по умолчанию
  4. Перезагрузить компьютер (рекомендуется)

**Проверка установки:**
```powershell
# В PowerShell
wmic sounddev get name | findstr /i "cable"
```
Должно показать устройство типа "CABLE Input" или "VB-Audio Virtual Cable"

#### SoundVolumeView
- **Скачать:** https://www.nirsoft.net/utils/sound_volume_view.html
- **Установка:**
  1. Скачать ZIP архив
  2. Распаковать в любую папку (например, `C:\Tools\SoundVolumeView\`)
  3. **НЕ требуется установка** - это portable утилита
  4. Запомнить путь к `SoundVolumeView.exe`

**Проверка:**
```powershell
# Перейти в папку с SoundVolumeView.exe
cd C:\Tools\SoundVolumeView
.\SoundVolumeView.exe /scomma
```
Должен вывести список аудио сессий в CSV формате

## 🚀 Установка проекта

### Шаг 1: Клонирование репозитория

```powershell
# В PowerShell или Git Bash
git clone <ваш-репозиторий>
cd zulip-desktop
```

### Шаг 2: Установка зависимостей

```powershell
# Установка npm пакетов
npm install

# Это автоматически запустит postinstall скрипт:
# electron-builder install-app-deps
```

### Шаг 2.1: Компиляция нативного модуля для Windows

**Важно:** Нативный модуль нужно скомпилировать отдельно для Windows!

```powershell
# Перейти в папку Windows addon
cd native-addon/win

# Установить зависимости
npm install

# Скомпилировать модуль
npm run build

# Проверить что файл создан
dir build\Release\capture.node

# Вернуться в корень
cd ..\..
```

**Если компиляция не удалась:**
1. Убедитесь что Visual Studio Build Tools установлены
2. Убедитесь что Windows SDK установлен
3. Попробуйте:
   ```powershell
   npm install -g node-gyp
   node-gyp rebuild --verbose
   ```

**После компиляции:**
Файл `capture.node` должен быть в `native-addon/win/build/Release/capture.node`

**Если возникают ошибки с native модулями:**
```powershell
# Пересобрать нативные модули
npm rebuild

# Или конкретно для Windows addon
cd native-addon/win
npm install
npm run build
cd ../..
```

### Шаг 3: Компиляция TypeScript

```powershell
# Проверка компиляции
npm run test
# или
tsc -p tsconfig.json --skipLibCheck
```

### Шаг 4: Настройка SoundVolumeView (опционально)

Если SoundVolumeView не в PATH, приложение попытается найти его автоматически.
Если не найдет - можно указать путь вручную через UI или:

```powershell
# Создать папку tools в корне проекта
mkdir tools

# Скопировать SoundVolumeView.exe в tools/
copy C:\Tools\SoundVolumeView\SoundVolumeView.exe tools\
```

## ▶️ Запуск приложения

### Режим разработки

```powershell
# Обычный запуск
npm start

# С отладкой
npm run start-win
```

### Сборка для Windows

```powershell
# Только сборка (без установщика)
npm run build-for-win

# Полная сборка с установщиком
npm run dist-win

# Без подписи (для тестирования)
npm run build-win-nosign
```

## 🔧 Проверка работоспособности

### 1. Проверка Virtual Cable

При запуске приложения проверьте логи:
```
[Virtual Cable] ✅ Device detected, auto-enabling mode
```

Если не найдено:
```
[Virtual Cable] No virtual audio device found
```
→ Установите VB-Cable и перезагрузите компьютер

### 2. Проверка SoundVolumeView

В консоли разработчика (F12) или через API:
```javascript
// Проверка готовности
const result = await window.audioApi.checkReady();
console.log('SVV Ready:', result.isReady);

// Получение списка приложений
const sessions = await window.audioApi.getSessions();
console.log('Audio sessions:', sessions);
```

### 3. Проверка нативного модуля

Приложение должно автоматически загрузить `native-addon.node` или `capture.node`.

Если ошибка загрузки:
```powershell
# Проверить наличие файла
dir dist-electron\native-addon.node
dir native-addon\win\capture.node

# Если нет - пересобрать
cd native-addon/win
npm run build
```

## ⚠️ Частые проблемы и решения

### Проблема: `node-gyp` не может скомпилировать нативный модуль

**Решение:**
```powershell
# Установить build tools глобально
npm install --global windows-build-tools

# Или установить Visual Studio Build Tools вручную
# Затем пересобрать:
npm rebuild
```

### Проблема: SoundVolumeView не найден

**Решение:**
1. Убедитесь, что `SoundVolumeView.exe` доступен
2. Добавьте в PATH или укажите путь вручную через UI
3. Или положите в `tools/SoundVolumeView.exe`

### Проблема: VB-Cable не определяется

**Решение:**
1. Установите VB-Cable от имени администратора
2. **Перезагрузите компьютер** (важно!)
3. Проверьте в диспетчере устройств Windows:
   - Панель управления → Диспетчер устройств → Звуковые устройства
   - Должно быть "VB-Audio Virtual Cable"

### Проблема: Ошибки при `npm install`

**Решение:**
```powershell
# Очистить кэш и переустановить
npm cache clean --force
rmdir /s /q node_modules
del package-lock.json
npm install
```

### Проблема: TypeScript ошибки компиляции

**Решение:**
```powershell
# Проверить версию TypeScript
npm list typescript

# Если старая версия:
npm install --save-dev typescript@^5.0.4

# Компиляция с игнорированием ошибок библиотек
tsc -p tsconfig.json --skipLibCheck
```

## 📝 Структура файлов на Windows

После установки структура должна быть:

```
zulip-desktop/
├── node_modules/          # npm зависимости
├── dist-electron/         # Скомпилированные файлы
│   ├── index.js          # Main process
│   ├── renderer.js       # Renderer process
│   ├── preload.js        # Preload script
│   └── native-addon.node # Нативный модуль (Windows)
├── native-addon/
│   └── win/
│       ├── capture.node   # Скомпилированный модуль
│       └── src/           # Исходники C++
├── tools/                 # Опционально: SoundVolumeView.exe
└── app/                   # Исходный код
```

## 🧪 Тестирование

### Unit тесты
```powershell
npm run test-unit
```

### Проверка линтера
```powershell
npm run test
```

## 📦 Сборка релиза

```powershell
# Полная сборка с установщиком
npm run dist-win

# Результат будет в:
# dist/RMConnect-5.26.2-x64.exe
```

## 🔍 Отладка

### Логи приложения
- Основные логи: `electron-debug.log`
- Preload логи: `preload-debug.log`
- Ошибки: `error.log`

### Включение детального логирования
```powershell
# В PowerShell
$env:ELECTRON_ENABLE_LOGGING=1
npm start
```

## 🤖 Автоматическая настройка

Для автоматической проверки и настройки используйте скрипт:

```powershell
# В PowerShell (может потребоваться разрешение)
npm run setup-windows

# Или напрямую:
PowerShell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Скрипт проверит:
- ✅ Версии Node.js, npm, Python
- ✅ Наличие VB-Cable
- ✅ Установит зависимости
- ✅ Скомпилирует нативный модуль
- ✅ Скопирует модуль в нужное место
- ✅ Проверит наличие SoundVolumeView

### Проверка синтаксиса скрипта

Перед запуском можно проверить синтаксис скрипта:

```powershell
npm run test-setup-script
```

Этот тест проверит:
- ✅ Корректность синтаксиса PowerShell
- ✅ Баланс скобок `{}` и `()`
- ✅ Возможность загрузки скрипта как модуля

## ✅ Чеклист перед запуском

- [ ] Node.js >= 18 установлен
- [ ] Python 3.x установлен и в PATH
- [ ] Visual Studio Build Tools установлены
- [ ] Git установлен
- [ ] VB-Audio Virtual Cable установлен и компьютер перезагружен
- [ ] SoundVolumeView.exe доступен (в PATH или в tools/)
- [ ] `npm install` выполнен успешно
- [ ] Нативный модуль скомпилирован (`native-addon/win/build/Release/capture.node` существует)
- [ ] Модуль скопирован в `dist-electron/native-addon.node` (автоматически при сборке)

## 🆘 Если ничего не помогает

1. Проверьте версии:
   ```powershell
   node -v      # Должно быть >= 18
   npm -v       # Должно быть >= 9
   python --version  # Должно быть 3.x
   ```

2. Пересоберите всё с нуля:
   ```powershell
   npm cache clean --force
   rmdir /s /q node_modules
   rmdir /s /q dist-electron
   del package-lock.json
   npm install
   npm run build-only
   ```

3. Проверьте права доступа (запустите PowerShell как Администратор)

4. Проверьте антивирус - он может блокировать компиляцию нативных модулей

