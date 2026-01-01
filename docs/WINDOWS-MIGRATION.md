# 📦 Миграция с macOS на Windows

## Что нужно сделать на Windows после клонирования

### 1. Установить системные зависимости

```powershell
# Node.js >= 18
# https://nodejs.org/

# Python 3.x (важно: отметить "Add to PATH")
# https://www.python.org/downloads/

# Visual Studio Build Tools
# https://visualstudio.microsoft.com/downloads/
# Выбрать: "Build Tools for Visual Studio 2022"
# При установке выбрать: "Desktop development with C++"
```

### 2. Установить аудио компоненты

```powershell
# VB-Audio Virtual Cable (ОБЯЗАТЕЛЬНО)
# https://vb-audio.com/Cable/
# После установки ПЕРЕЗАГРУЗИТЬ компьютер!

# SoundVolumeView (опционально, но рекомендуется)
# https://www.nirsoft.net/utils/sound_volume_view.html
# Распаковать в tools/ или добавить в PATH
```

### 3. Клонировать и настроить проект

```powershell
# Клонировать репозиторий
git clone <ваш-репозиторий>
cd zulip-desktop

# Автоматическая настройка (рекомендуется)
npm run setup-windows
```

**Или вручную:**

```powershell
# Установить зависимости
npm install

# ⚠️ ВАЖНО: Скомпилировать Windows нативный модуль
cd native-addon/win
npm install
npm run build
cd ../..

# Проверить что модуль скомпилирован
dir native-addon\win\build\Release\capture.node

# Скопировать модуль в dist-electron
npm run copy-addon-for-win
```

### 4. Запустить

```powershell
npm start
```

## 🔑 Ключевые отличия от macOS

### Нативный модуль

**macOS:** Использует `native-addon/addon.node` (Swift)
**Windows:** Использует `native-addon/win/build/Release/capture.node` (C++)

**Важно:** На Windows модуль нужно компилировать отдельно!

### Команды сборки

**macOS:**
```bash
npm run build-only  # Использует cp команду
```

**Windows:**
```powershell
npm run build-for-win      # Собирает и копирует Windows модуль
npm run copy-addon-for-win # Копирует модуль в dist-electron
```

### Пути к файлам

**macOS:** Использует прямые слеши `/`
**Windows:** Использует обратные слеши `\` или `path.join()`

Код уже использует `path.join()`, так что это не проблема.

## 📋 Чеклист для Windows

- [ ] Node.js >= 18 установлен
- [ ] Python 3.x установлен и в PATH
- [ ] Visual Studio Build Tools установлены
- [ ] VB-Audio Virtual Cable установлен
- [ ] **Компьютер перезагружен** после установки VB-Cable
- [ ] SoundVolumeView доступен (опционально)
- [ ] `npm install` выполнен успешно
- [ ] Нативный модуль скомпилирован (`native-addon/win/build/Release/capture.node`)
- [ ] Модуль скопирован (`dist-electron/native-addon.node`)

## 🐛 Частые проблемы

### Ошибка компиляции нативного модуля

**Причина:** Не установлены Visual Studio Build Tools или Windows SDK

**Решение:**
```powershell
# Установить build tools
npm install -g windows-build-tools

# Или установить Visual Studio Build Tools вручную
# Затем пересобрать:
cd native-addon/win
npm run build
```

### VB-Cable не определяется

**Причина:** Компьютер не был перезагружен после установки

**Решение:**
1. Установите VB-Cable от имени администратора
2. **Перезагрузите компьютер** (обязательно!)
3. Проверьте: `wmic sounddev get name | findstr /i "cable"`

### SoundVolumeView не найден

**Решение:**
1. Положите `SoundVolumeView.exe` в `tools/` папку проекта
2. Или добавьте путь в PATH Windows
3. Или укажите путь вручную через UI приложения

### Ошибка "Cannot find module 'native-addon.node'"

**Причина:** Модуль не скомпилирован или не скопирован

**Решение:**
```powershell
# Скомпилировать
cd native-addon/win
npm run build

# Вернуться в корень и скопировать
cd ../..
npm run copy-addon-for-win
```

## 📚 Документация

- **[windows-setup.md](./windows-setup.md)** - Полная инструкция по настройке
- **[windows-quick-start.md](./windows-quick-start.md)** - Быстрый старт
- **[windows-checklist.md](./windows-checklist.md)** - Чеклист для разработки

## ✅ Быстрая проверка готовности

```powershell
# Проверить версии
node -v        # >= 18
npm -v         # >= 9
python --version  # 3.x

# Проверить VB-Cable
wmic sounddev get name | findstr /i "cable"

# Проверить компиляцию модуля
dir native-addon\win\build\Release\capture.node

# Проверить копирование
dir dist-electron\native-addon.node
```

## 🚀 Готово к работе!

После выполнения всех шагов проект должен работать на Windows так же, как на macOS.

