import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";
import { SVVLocator } from "./svvLocator.js";

const execFileAsync = promisify(execFile);

export interface AudioSession {
    processId: number;
    processName: string; // "game.exe"
    displayName: string; // "Counter-Strike 2"
    processPath: string;
    volume: number; // 0-100
    muted: boolean;
    deviceName?: string;
}

export interface AudioDevice {
    name: string;
    id: string;
    isDefault: boolean;
}

export class AudioSessionService {
    private svvLocator: SVVLocator;
    private initialized: boolean = false;

    constructor() {
        this.svvLocator = new SVVLocator();
        this.initialize();
    }
    
    /**
     * Асинхронная инициализация
     */
    private async initialize(): Promise<void> {
        log.info("[AudioSession] 🔊 Initializing AudioSessionService...");
        try {
            const svvPath = await this.svvLocator.findSVV();
            if (svvPath) {
                log.info(`[AudioSession] ✅ SoundVolumeView ready at: ${svvPath}`);
                const hasVC = await this.hasVBCable();
                if (hasVC) {
                    const vcName = await this.getVBCableDeviceName();
                    log.info(`[AudioSession] ✅ VB-Cable found: ${vcName}`);
                } else {
                    log.warn("[AudioSession] ⚠️ VB-Cable NOT found via SVV");
                }
            } else {
                log.warn("[AudioSession] ⚠️ SoundVolumeView not found - audio routing disabled");
            }
            this.initialized = true;
        } catch (error: any) {
            log.error("[AudioSession] ❌ Initialization error:", error.message);
        }
    }

    /**
     * Проверить готовность сервиса
     */
    async isReady(): Promise<boolean> {
        return await this.svvLocator.isReady();
    }

    /**
     * Получить путь к SoundVolumeView
     */
    private async getSVVPath(): Promise<string | null> {
        return await this.svvLocator.findSVV();
    }

    /**
     * Получить список аудио сессий (приложений со звуком)
     */
    async getAudioSessions(): Promise<AudioSession[]> {
        const svvPath = await this.getSVVPath();
        if (!svvPath) {
            throw new Error("SoundVolumeView not found");
        }

        try {
            const { stdout } = await execFileAsync(
                svvPath,
                [
                    "/scomma",
                    "",
                    "/Columns",
                    "Name,Type,Direction,Process ID,Process Path,Volume Percent,Muted,Device Name",
                ],
                {
                    windowsHide: true,
                    encoding: "utf-8",
                }
            );

            return this.parseCSV(stdout);
        } catch (error: any) {
            log.error("[AudioSession] Error getting sessions:", error);
            throw new Error(`Failed to get audio sessions: ${error.message}`);
        }
    }

    /**
     * Парсинг CSV ответа от SoundVolumeView
     */
    private parseCSV(csv: string): AudioSession[] {
        const lines = csv.trim().split("\n");
        if (lines.length < 2) {
            return [];
        }

        // Пропускаем заголовок
        const dataLines = lines.slice(1);
        const sessions: AudioSession[] = [];

        for (const line of dataLines) {
            if (!line.trim()) continue;

            const columns = this.parseCSVLine(line);
            if (columns.length < 7) continue;

            const type = columns[1]?.trim();
            const direction = columns[2]?.trim();

            // Фильтруем только приложения с выводом звука
            if (type === "Application" && direction === "Render") {
                const processId = parseInt(columns[3]?.trim() || "0", 10);
                const processPath = columns[4]?.trim() || "";
                const volume = parseInt(columns[5]?.trim() || "0", 10);
                const muted = columns[6]?.trim() === "Yes";
                const deviceName = columns[7]?.trim() || "";

                if (processId > 0 && processPath) {
                    const processName = this.extractProcessName(processPath);
                    const displayName = this.getDisplayName(processName, columns[0]?.trim() || "");

                    sessions.push({
                        processId,
                        processName,
                        displayName,
                        processPath,
                        volume,
                        muted,
                        deviceName,
                    });
                }
            }
        }

        return sessions;
    }

    /**
     * Парсинг CSV строки с учётом кавычек
     */
    private parseCSVLine(line: string): string[] {
        const columns: string[] = [];
        let current = "";
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === "," && !inQuotes) {
                columns.push(current.trim());
                current = "";
            } else {
                current += char;
            }
        }
        columns.push(current.trim());

        return columns;
    }

    /**
     * Извлечь имя процесса из пути
     */
    private extractProcessName(processPath: string): string {
        const parts = processPath.split(/[/\\]/);
        return parts[parts.length - 1] || "";
    }

    /**
     * Получить красивое имя для отображения
     */
    private getDisplayName(processName: string, sessionName: string): string {
        // Используем словарь известных приложений
        const knownApps: Record<string, string> = {
            "cs2.exe": "Counter-Strike 2",
            "dota2.exe": "Dota 2",
            "valorant.exe": "VALORANT",
            "league of legends.exe": "League of Legends",
            "spotify.exe": "Spotify",
            "chrome.exe": "Google Chrome",
            "firefox.exe": "Mozilla Firefox",
            "discord.exe": "Discord",
            "steam.exe": "Steam",
        };

        const lowerName = processName.toLowerCase();
        if (knownApps[lowerName]) {
            return knownApps[lowerName];
        }

        // Используем имя сессии, если оно есть
        if (sessionName && sessionName !== processName) {
            return sessionName;
        }

        // Fallback: capitalize имя процесса без расширения
        const nameWithoutExt = processName.replace(/\.[^.]+$/, "");
        return this.capitalize(nameWithoutExt);
    }

    /**
     * Capitalize строку
     */
    private capitalize(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    }

    /**
     * Получить список аудио устройств
     */
    async getAudioDevices(): Promise<AudioDevice[]> {
        const svvPath = await this.getSVVPath();
        if (!svvPath) {
            throw new Error("SoundVolumeView not found");
        }

        try {
            const { stdout } = await execFileAsync(
                svvPath,
                ["/scomma", "", "/Columns", "Name,Type,Direction"],
                {
                    windowsHide: true,
                    encoding: "utf-8",
                }
            );

            return this.parseDevicesCSV(stdout);
        } catch (error: any) {
            log.error("[AudioSession] Error getting devices:", error);
            throw new Error(`Failed to get audio devices: ${error.message}`);
        }
    }

    /**
     * Парсинг CSV для устройств
     */
    private parseDevicesCSV(csv: string): AudioDevice[] {
        const lines = csv.trim().split("\n");
        if (lines.length < 2) {
            return [];
        }

        const dataLines = lines.slice(1);
        const devices: AudioDevice[] = [];

        for (const line of dataLines) {
            if (!line.trim()) continue;

            const columns = this.parseCSVLine(line);
            if (columns.length < 3) continue;

            const type = columns[1]?.trim();
            const direction = columns[2]?.trim();

            // Фильтруем только устройства вывода
            if (type === "Device" && direction === "Render") {
                const name = columns[0]?.trim() || "";
                if (name) {
                    devices.push({
                        name,
                        id: name, // SoundVolumeView использует имя как ID
                        isDefault: name.toLowerCase().includes("default"),
                    });
                }
            }
        }

        return devices;
    }

    /**
     * Перенаправить звук приложения на устройство
     */
    async setAppAudioDevice(processName: string, deviceName: string): Promise<boolean> {
        log.info(`[AudioSession] 🔀 Routing ${processName} → ${deviceName}`);
        
        const svvPath = await this.getSVVPath();
        if (!svvPath) {
            log.error("[AudioSession] ❌ Cannot route - SoundVolumeView not found");
            throw new Error("SoundVolumeView not found");
        }

        try {
            log.info(`[AudioSession] Executing: ${svvPath} /SetAppDefault "${deviceName}" all "${processName}"`);
            await execFileAsync(
                svvPath,
                ["/SetAppDefault", deviceName, "all", processName],
                {
                    windowsHide: true,
                }
            );

            log.info(`[AudioSession] ✅ Successfully routed ${processName} to ${deviceName}`);
            return true;
        } catch (error: any) {
            log.error(`[AudioSession] ❌ Error routing ${processName} to ${deviceName}:`, error.message);
            throw new Error(`Failed to route audio: ${error.message}`);
        }
    }

    /**
     * Вернуть приложение на устройство по умолчанию
     */
    async restoreDefaultDevice(processName: string): Promise<boolean> {
        const svvPath = await this.getSVVPath();
        if (!svvPath) {
            throw new Error("SoundVolumeView not found");
        }

        try {
            // Получаем устройство по умолчанию
            const devices = await this.getAudioDevices();
            const defaultDevice = devices.find((d) => d.isDefault) || devices[0];

            if (!defaultDevice) {
                throw new Error("No default device found");
            }

            await execFileAsync(
                svvPath,
                ["/SetAppDefault", defaultDevice.name, "all", processName],
                {
                    windowsHide: true,
                }
            );

            log.info(`[AudioSession] Restored ${processName} to default device`);
            return true;
        } catch (error: any) {
            log.error(`[AudioSession] Error restoring ${processName}:`, error);
            throw new Error(`Failed to restore audio: ${error.message}`);
        }
    }

    /**
     * Проверить наличие VB-Cable устройства
     */
    async hasVBCable(): Promise<boolean> {
        try {
            const devices = await this.getAudioDevices();
            return devices.some(
                (d) =>
                    d.name.toLowerCase().includes("cable") ||
                    d.name.toLowerCase().includes("vb-audio") ||
                    d.name.toLowerCase().includes("virtual")
            );
        } catch {
            return false;
        }
    }

    /**
     * Получить имя VB-Cable устройства
     */
    async getVBCableDeviceName(): Promise<string | null> {
        try {
            const devices = await this.getAudioDevices();
            const vcDevice = devices.find(
                (d) =>
                    d.name.toLowerCase().includes("cable input") ||
                    d.name.toLowerCase().includes("vb-audio virtual cable")
            );

            return vcDevice?.name || null;
        } catch {
            return null;
        }
    }
}

