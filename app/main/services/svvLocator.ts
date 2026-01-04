import { app } from "electron/main";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import log from "electron-log";

const execFileAsync = promisify(execFile);

const SVV_PATH_FILE = path.join(app.getPath("userData"), "svv-path.txt");

export class SVVLocator {
    private cachedPath: string | null = null;

    /**
     * Поиск SoundVolumeView.exe в системе
     */
    async findSVV(): Promise<string | null> {
        log.info("[SVV] 🔍 Starting SoundVolumeView search...");
        
        // 1. Проверяем сохранённый путь
        const savedPath = this.getSavedPath();
        if (savedPath && await this.isValidPath(savedPath)) {
            this.cachedPath = savedPath;
            log.info(`[SVV] ✅ Found (cached): ${savedPath}`);
            return savedPath;
        }

        // 2. Поиск в PATH
        log.info("[SVV] Searching in PATH...");
        const pathResult = await this.findInPath();
        if (pathResult) {
            this.cachedPath = pathResult;
            await this.savePath(pathResult);
            log.info(`[SVV] ✅ Found in PATH: ${pathResult}`);
            return pathResult;
        }

        // 3. Проверка стандартных путей
        const standardPaths = this.getStandardPaths();
        log.info(`[SVV] Searching in ${standardPaths.length} standard paths...`);
        for (const dir of standardPaths) {
            const fullPath = path.join(dir, "SoundVolumeView.exe");
            if (await this.isValidPath(fullPath)) {
                this.cachedPath = fullPath;
                await this.savePath(fullPath);
                log.info(`[SVV] ✅ Found at: ${fullPath}`);
                return fullPath;
            }
        }

        log.warn("[SVV] ❌ SoundVolumeView NOT FOUND! Audio routing will not work.");
        log.warn("[SVV] Download from: https://www.nirsoft.net/utils/sound_volume_view.html");
        log.warn("[SVV] Extract to: tools/ folder in project root");
        return null;
    }

    /**
     * Поиск в PATH через where команду
     */
    private async findInPath(): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync("where", ["SoundVolumeView.exe"], {
                windowsHide: true,
            });
            const lines = stdout.trim().split("\n");
            if (lines.length > 0 && lines[0]) {
                const foundPath = lines[0].trim();
                if (await this.isValidPath(foundPath)) {
                    return foundPath;
                }
            }
        } catch (error) {
            // where не найден или SoundVolumeView не в PATH
            log.debug("[SVV] Not found in PATH");
        }
        return null;
    }

    /**
     * Получить стандартные пути для поиска
     */
    private getStandardPaths(): string[] {
        const paths: string[] = [];

        // Downloads
        const downloadsPath = path.join(app.getPath("home"), "Downloads");
        paths.push(downloadsPath);

        // Program Files
        const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
        paths.push(programFiles);
        paths.push(path.join(programFiles, "SoundVolumeView"));

        // Program Files (x86)
        const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        paths.push(programFilesX86);
        paths.push(path.join(programFilesX86, "SoundVolumeView"));

        // Local AppData
        const localAppData = app.getPath("userData");
        paths.push(localAppData);
        paths.push(path.join(localAppData, "SoundVolumeView"));

        // Текущая директория приложения
        paths.push(process.cwd());
        paths.push(path.join(process.cwd(), "tools"));

        // 🆕 В собранном приложении SoundVolumeView.exe находится в resources/tools/
        if (app.isPackaged) {
            const resourcesPath = process.resourcesPath || path.join(process.execPath, "..", "resources");
            paths.push(path.join(resourcesPath, "tools"));
        }

        return paths;
    }

    /**
     * Проверить валидность пути
     */
    private async isValidPath(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Получить сохранённый путь
     */
    private getSavedPath(): string | null {
        try {
            if (fs.existsSync(SVV_PATH_FILE)) {
                const saved = fs.readFileSync(SVV_PATH_FILE, "utf-8").trim();
                if (saved) {
                    return saved;
                }
            }
        } catch (error) {
            log.error("[SVV] Error reading saved path:", error);
        }
        return null;
    }

    /**
     * Сохранить путь
     */
    async savePath(filePath: string): Promise<void> {
        try {
            await fs.promises.writeFile(SVV_PATH_FILE, filePath, "utf-8");
            this.cachedPath = filePath;
            log.info(`[SVV] Path saved: ${filePath}`);
        } catch (error) {
            log.error("[SVV] Error saving path:", error);
        }
    }

    /**
     * Установить путь вручную
     */
    async setManualPath(filePath: string): Promise<boolean> {
        if (await this.isValidPath(filePath)) {
            await this.savePath(filePath);
            this.cachedPath = filePath;
            return true;
        }
        return false;
    }

    /**
     * Получить текущий путь (из кэша или файла)
     */
    getCurrentPath(): string | null {
        if (this.cachedPath) {
            return this.cachedPath;
        }
        return this.getSavedPath();
    }

    /**
     * Проверить готовность
     */
    async isReady(): Promise<boolean> {
        const currentPath = this.getCurrentPath();
        if (!currentPath) {
            return false;
        }
        return await this.isValidPath(currentPath);
    }
}

