import { contextBridge } from "electron/renderer";
import electron_bridge, { bridgeEvents } from "./electron-bridge.js";
import * as NetworkError from "./pages/network.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import { WalkieTalkieStatus } from "../../common/typed-ipc.js";
import path from "node:path";
import { app } from "@electron/remote";

ipcRenderer.send("preload-log", "✅ Preload: Начало выполнения");
ipcRenderer.send("preload-log", `✅ Preload: Загружен для URL: ${window.location.href}`);
ipcRenderer.send("preload-log", `✅ Preload: ipcRenderer.send: ${typeof ipcRenderer.send}, ipcRenderer.invoke: ${typeof ipcRenderer.invoke}`);

// Expose native addon methods via IPC (async)
ipcRenderer.send("preload-log", "✅ Preload: Starting exposure of nativeScreenCapture");
contextBridge.exposeInMainWorld("nativeScreenCapture", {
  selectSourceWithPicker: () => ipcRenderer.invoke('select-source-with-picker'),
  startCaptureWithCompletion: () => ipcRenderer.invoke('start-capture'),
  stopCaptureWithCompletion: () => ipcRenderer.invoke('stop-capture')
});
ipcRenderer.send("preload-log", "✅ Preload: nativeScreenCapture exposed");

// Регистрация обработчика toggle-walkie-talkie
ipcRenderer.send("preload-log", "✅ Preload: Регистрация обработчика toggle-walkie-talkie");
ipcRenderer.on("toggle-walkie-talkie", (event, isMuted: boolean) => {
    ipcRenderer.send("preload-log", `Preload: Получено событие toggle-walkie-talkie: isMuted=${isMuted}`);
    bridgeEvents.emit("toggle-walkie-talkie", isMuted);
    ipcRenderer.send("preload-log", `Preload: Отправлено событие toggle-walkie-talkie в bridgeEvents: isMuted=${isMuted}`);
    const listenerCount = bridgeEvents.listenerCount("toggle-walkie-talkie");
    ipcRenderer.send("preload-log", `Preload: Количество слушателей toggle-walkie-talkie: ${listenerCount}`);
});

// Расширяем electron_bridge для обработки событий микрофона
contextBridge.exposeInMainWorld("electron_bridge", {
    ...electron_bridge,
    setMicHotkey: (enabled: boolean, hotkey: string) => {
        ipcRenderer.send("preload-log", `Preload: Установка горячей клавиши микрофона: ${hotkey}`);
        ipcRenderer.send("walkie-talkie-status", { enabled: enabled, key: hotkey });
    },
    onMicStateChanged: (callback: (data: boolean) => void) => {
        ipcRenderer.send("preload-log", "Preload: Установка слушателя для toggle-walkie-talkie");
        bridgeEvents.on("toggle-walkie-talkie", callback);
        ipcRenderer.send("preload-log", `Preload: Зарегистрирован слушатель toggle-walkie-talkie, текущих слушателей: ${bridgeEvents.listenerCount("toggle-walkie-talkie")}`);
    }
});

// Остальной код preload.ts остаётся без изменений
contextBridge.exposeInMainWorld("ipcRenderer", {
    invoke: async (channel: any, ...args: unknown[]) => {
        ipcRenderer.send("preload-log", `Zulip Preload: Запрос ${channel} с аргументами: ${JSON.stringify(args)}`);
        try {
            const result = await ipcRenderer.invoke(channel, ...args);
            ipcRenderer.send("preload-log", `Zulip Preload: Успех ${channel}: ${Array.isArray(result) ? result.map((s: any) => s.name || JSON.stringify(s)).join(', ') : JSON.stringify(result)}`);
            return result;
        } catch (error) {
            ipcRenderer.send("preload-log", `Zulip Preload: Ошибка ${channel}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    },
    on: (channel: any, listener: (event: any, ...args: any[]) => void) => {
        ipcRenderer.send("preload-log", `Zulip Preload: Установка слушателя для канала ${channel}`);
        ipcRenderer.on(channel, listener);
    }
});

ipcRenderer.on("logout", () => {
    bridgeEvents.emit("logout");
});

ipcRenderer.on("show-keyboard-shortcuts", () => {
    bridgeEvents.emit("show-keyboard-shortcuts");
});

ipcRenderer.on("show-notification-settings", () => {
    bridgeEvents.emit("show-notification-settings");
});

ipcRenderer.on("trigger-open-desktop-picker", () => {
    ipcRenderer.send("preload-log", "✅ Preload: Получена команда trigger-open-desktop-picker (direct)");
    electron_bridge.send_event("open-desktop-picker");
});

ipcRenderer.on("requestDesktopSources", () => {
    ipcRenderer.send("preload-log", "✅ Preload: Получена команда requestDesktopSources (direct)");
    electron_bridge.send_event("requestDesktopSources");
});

ipcRenderer.on("forward-message", (event, channel) => {
    ipcRenderer.send("preload-log", `✅ Preload: Получено forward-message с каналом: ${channel}`);
    if (channel === "trigger-open-desktop-picker") {
        electron_bridge.send_event("open-desktop-picker");
    }
    if (channel === "request-desktop-sources") {
        electron_bridge.send_event("requestDesktopSources");
    }
});

ipcRenderer.on("desktop-sources-response", (event, response) => {
    const sourcesNames = response.sources ? response.sources.map(s => s.name).join(', ') : '[]';
    const errorMessage = response.error || 'none';
    ipcRenderer.send("preload-log", `✅ Preload: Получен ответ desktop-sources-response: sources=[${sourcesNames}], error=${errorMessage}`);
    electron_bridge.send_event("desktop-sources-response", response);
});

window.addEventListener("load", () => {
    if (!location.href.includes("app/renderer/network.html")) {
        return;
    }
    const $reconnectButton = document.querySelector("#reconnect")!;
    const $settingsButton = document.querySelector("#settings")!;
    NetworkError.init($reconnectButton, $settingsButton);
});

ipcRenderer.send("preload-log", "✅ Preload: Script completed execution");