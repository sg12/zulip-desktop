# ✅ Чеклист для Windows разработки

## Перед началом работы

### Обязательное ПО
- [ ] **Node.js >= 18** установлен и в PATH
- [ ] **Python 3.x** установлен и в PATH (отметить при установке!)
- [ ] **Visual Studio Build Tools** установлены
  - Или `npm install -g windows-build-tools`
- [ ] **Git** установлен

### Аудио компоненты
- [ ] **VB-Audio Virtual Cable** установлен
- [ ] **Компьютер перезагружен** после установки VB-Cable
- [ ] **SoundVolumeView.exe** доступен
  - В PATH, или в `tools/`, или указан путь вручную

## После клонирования репозитория

### Первая настройка
```powershell
# 1. Автоматическая настройка (рекомендуется)
npm run setup-windows

# ИЛИ вручную:
# 2. Установить зависимости
npm install

# 3. Скомпилировать Windows нативный модуль
cd native-addon/win
npm install
npm run build
cd ../..

# 4. Проверить что модуль скомпилирован
dir native-addon\win\build\Release\capture.node
```

### Проверка готовности
```powershell
# Проверить версии
node -v        # Должно быть >= 18
npm -v         # Должно быть >= 9
python --version  # Должно быть 3.x

# Проверить VB-Cable
wmic sounddev get name | findstr /i "cable"
# Должно показать устройство с "cable" или "vb-audio"

# Проверить компиляцию TypeScript
tsc -p tsconfig.json --skipLibCheck
```

## Перед каждым запуском

### Быстрая проверка
```powershell
# Проверить что нативный модуль на месте
dir dist-electron\native-addon.node
# Если нет - скопировать:
npm run copy-addon-for-win

# Запустить
npm start
```

## Если что-то сломалось

### Пересборка с нуля
```powershell
# Очистить всё
rmdir /s /q node_modules
rmdir /s /q dist-electron
del package-lock.json

# Переустановить
npm install

# Пересобрать нативный модуль
cd native-addon/win
rmdir /s /q build
rmdir /s /q node_modules
npm install
npm run build
cd ../..

# Скопировать модуль
npm run copy-addon-for-win
```

## Структура файлов (что должно быть)

```
zulip-desktop/
├── node_modules/                    ✅ После npm install
├── dist-electron/
│   └── native-addon.node           ✅ После copy-addon-for-win
├── native-addon/
│   └── win/
│       ├── build/
│       │   └── Release/
│       │       └── capture.node    ✅ После npm run build
│       └── node_modules/           ✅ После npm install в этой папке
├── tools/
│   └── SoundVolumeView.exe         ⚠️  Опционально (можно положить)
└── app/                            ✅ Исходный код
```

## Команды для Windows

```powershell
# Разработка
npm start                    # Обычный запуск
npm run start-win           # С отладкой

# Сборка
npm run build-for-win       # Собрать для Windows
npm run copy-addon-for-win  # Скопировать нативный модуль
npm run dist-win            # Полная сборка с установщиком

# Тестирование
npm run test-unit           # Unit тесты
npm run test                # Линтинг и проверки
```

## Важные замечания

1. **Нативный модуль** нужно компилировать отдельно в `native-addon/win/`
2. **VB-Cable** требует перезагрузки компьютера после установки
3. **SoundVolumeView** не требует установки - это portable утилита
4. **Пути** в Windows используют обратные слеши `\`
5. **PowerShell** рекомендуется вместо CMD для лучшей поддержки

## Полезные ссылки

- [Полная инструкция](./windows-setup.md)
- [Быстрый старт](./windows-quick-start.md)
- [Документация по аудио маршрутизации](./audio-routing.md)

