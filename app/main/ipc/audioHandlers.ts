import { ipcMain } from "electron/main";
import log from "electron-log";
import { AudioSessionService } from "../services/audioSessionService.js";
import { SVVLocator } from "../services/svvLocator.js";

const audioSessionService = new AudioSessionService();
const svvLocator = new SVVLocator();

/**
 * Регистрация IPC обработчиков для работы с аудио
 */
export function registerAudioHandlers(): void {
    /**
     * Проверить готовность сервиса
     */
    ipcMain.handle("audio:checkReady", async () => {
        try {
            const isReady = await audioSessionService.isReady();
            return { success: true, isReady };
        } catch (error: any) {
            log.error("[AudioHandlers] checkReady error:", error);
            return { success: false, error: error.message };
        }
    });

    /**
     * Получить список аудио сессий (приложений со звуком)
     */
    ipcMain.handle("audio:getSessions", async () => {
        try {
            const sessions = await audioSessionService.getAudioSessions();
            return { success: true, sessions };
        } catch (error: any) {
            log.error("[AudioHandlers] getSessions error:", error);
            return { success: false, error: error.message, sessions: [] };
        }
    });

    /**
     * Получить список аудио устройств
     */
    ipcMain.handle("audio:getDevices", async () => {
        try {
            const devices = await audioSessionService.getAudioDevices();
            return { success: true, devices };
        } catch (error: any) {
            log.error("[AudioHandlers] getDevices error:", error);
            return { success: false, error: error.message, devices: [] };
        }
    });

    /**
     * Перенаправить звук приложения на VB-Cable
     */
    ipcMain.handle("audio:routeToCable", async (event, processName: string) => {
        try {
            const vcDeviceName = await audioSessionService.getVBCableDeviceName();
            if (!vcDeviceName) {
                throw new Error("VB-Cable device not found");
            }

            const success = await audioSessionService.setAppAudioDevice(processName, vcDeviceName);
            return { success, deviceName: vcDeviceName };
        } catch (error: any) {
            log.error(`[AudioHandlers] routeToCable error for ${processName}:`, error);
            return { success: false, error: error.message };
        }
    });

    /**
     * Вернуть приложение на устройство по умолчанию
     */
    ipcMain.handle("audio:restoreDefault", async (event, processName: string) => {
        try {
            const success = await audioSessionService.restoreDefaultDevice(processName);
            return { success };
        } catch (error: any) {
            log.error(`[AudioHandlers] restoreDefault error for ${processName}:`, error);
            return { success: false, error: error.message };
        }
    });

    /**
     * Установить путь к SoundVolumeView вручную
     */
    ipcMain.handle("audio:setManualPath", async (event, exePath: string) => {
        try {
            const success = await svvLocator.setManualPath(exePath);
            return { success };
        } catch (error: any) {
            log.error("[AudioHandlers] setManualPath error:", error);
            return { success: false, error: error.message };
        }
    });

    /**
     * Проверить наличие VB-Cable
     */
    ipcMain.handle("audio:hasVBCable", async () => {
        try {
            const hasVC = await audioSessionService.hasVBCable();
            return { success: true, hasVBCable: hasVC };
        } catch (error: any) {
            log.error("[AudioHandlers] hasVBCable error:", error);
            return { success: false, hasVBCable: false };
        }
    });

    /**
     * Получить текущий путь к SoundVolumeView
     */
    ipcMain.handle("audio:getSVVPath", async () => {
        try {
            const path = svvLocator.getCurrentPath();
            return { success: true, path };
        } catch (error: any) {
            log.error("[AudioHandlers] getSVVPath error:", error);
            return { success: false, path: null };
        }
    });

    log.info("[AudioHandlers] Audio IPC handlers registered");
}

