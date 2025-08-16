# Инструкция по тестированию на Windows

## Быстрая проверка

1. **Откройте командную строку Windows (cmd)**
2. **Перейдите в папку с модулем:**
cd C:\путь\к\папке\с\модулем

3. **Запустите автоматический тест:**
run-test.bat

## Детальная диагностика (если есть проблемы)

1. **Откройте PowerShell от администратора**
2. **Разрешите выполнение скриптов:**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

Запустите диагностику:
powershell.\diagnose.ps1