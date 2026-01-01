# 🪟 Быстрый старт на Windows

## ⚡ Минимальные требования

1. **Node.js >= 18** - https://nodejs.org/
2. **Python 3.x** - https://www.python.org/downloads/ (отметить "Add to PATH")
3. **Visual Studio Build Tools** - https://visualstudio.microsoft.com/downloads/
4. **VB-Audio Virtual Cable** - https://vb-audio.com/Cable/ (после установки перезагрузить!)
5. **SoundVolumeView** (опционально) - https://www.nirsoft.net/utils/sound_volume_view.html

## 🚀 Быстрая установка

```powershell
# 1. Клонировать репозиторий
git clone <ваш-репозиторий>
cd zulip-desktop

# 2. Автоматическая настройка (рекомендуется)
npm run setup-windows

# 3. Или вручную:
npm install
cd native-addon/win
npm install
npm run build
cd ../..

# 4. Запустить
npm start
```

## 📚 Подробная инструкция

См. [docs/windows-setup.md](./docs/windows-setup.md) для детальной информации.

## 🔍 Проверка

```powershell
# Проверить версии
node -v      # >= 18
npm -v       # >= 9
python --version  # 3.x

# Проверить VB-Cable
wmic sounddev get name | findstr /i "cable"

# Проверить компиляцию модуля
dir native-addon\win\build\Release\capture.node
```

## ⚠️ Важно!

- После установки VB-Cable **обязательно перезагрузите компьютер**
- Нативный модуль нужно компилировать отдельно: `cd native-addon/win && npm run build`
- SoundVolumeView можно положить в `tools/SoundVolumeView.exe`

## 🆘 Проблемы?

См. раздел "Частые проблемы" в [docs/windows-setup.md](./docs/windows-setup.md)

