# 🚀 Быстрый старт на Windows

## Минимальный чеклист

### 1. Установить обязательное ПО

```powershell
# 1. Node.js >= 18
# Скачать: https://nodejs.org/

# 2. Python 3.x
# Скачать: https://www.python.org/downloads/
# ⚠️ Важно: Отметить "Add Python to PATH"

# 3. Visual Studio Build Tools
# Скачать: https://visualstudio.microsoft.com/downloads/
# Выбрать: "Build Tools for Visual Studio 2022"
# При установке выбрать: "Desktop development with C++"
```

### 2. Установить аудио компоненты

```powershell
# VB-Audio Virtual Cable
# Скачать: https://vb-audio.com/Cable/
# Установить от имени администратора
# ⚠️ ОБЯЗАТЕЛЬНО перезагрузить компьютер!

# SoundVolumeView (опционально, но рекомендуется)
# Скачать: https://www.nirsoft.net/utils/sound_volume_view.html
# Распаковать в любую папку (например, C:\Tools\SoundVolumeView\)
```

### 3. Клонировать и установить

```powershell
# Клонировать репозиторий
git clone <ваш-репозиторий>
cd zulip-desktop

# Установить зависимости
npm install

# Скомпилировать Windows нативный модуль
cd native-addon/win
npm install
npm run build
cd ../..

# Проверить что модуль скомпилирован
dir native-addon\win\build\Release\capture.node
```

### 4. Запустить

```powershell
# Запуск в режиме разработки
npm start

# Или с отладкой
npm run start-win
```

## ⚡ Быстрая проверка

```powershell
# Проверить версии
node -v        # Должно быть >= 18
npm -v         # Должно быть >= 9
python --version  # Должно быть 3.x

# Проверить VB-Cable
wmic sounddev get name | findstr /i "cable"

# Проверить компиляцию
tsc -p tsconfig.json --skipLibCheck
```

## 🐛 Если что-то не работает

### Ошибка компиляции нативного модуля
```powershell
# Установить build tools
npm install -g windows-build-tools

# Или установить Visual Studio Build Tools вручную
# Затем:
cd native-addon/win
npm run build
```

### SoundVolumeView не найден
- Положите `SoundVolumeView.exe` в `tools/` папку проекта
- Или добавьте путь в PATH Windows
- Или укажите путь вручную через UI приложения

### VB-Cable не определяется
1. Установите от имени администратора
2. **Перезагрузите компьютер** (обязательно!)
3. Проверьте в Диспетчере устройств → Звуковые устройства

## 📚 Полная инструкция

См. [windows-setup.md](./windows-setup.md) для детальной информации.

