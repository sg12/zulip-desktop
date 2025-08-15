import { clipboard } from "electron/common";
import {
  BrowserWindow,
  globalShortcut,
  type IpcMainEvent,
  type WebContents,
  app,
  dialog,
  powerMonitor,
  session,
  webContents,
  desktopCapturer,
} from "electron/main";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { autoUpdater } from "electron-updater";
import log from "electron-log";


import { GlobalKeyboardListener, IGlobalKeyDownMap, IGlobalKeyEvent } from 'node-global-key-listener';

import * as remoteMain from "@electron/remote/main";
import windowStateKeeper from "electron-window-state";

import * as ConfigUtil from "../common/config-util.js";
import { bundlePath, bundleUrl, publicPath } from "../common/paths.js";
import * as t from "../common/translation-util.js";
import type { MenuProperties } from "../common/types.js";
import type { RendererMessage, DesktopSource, JitsiLogData, WalkieTalkieStatus } from "../common/typed-ipc.js";

import { appUpdater, shouldQuitForUpdate } from "./autoupdater.js";
import * as BadgeSettings from "./badge-settings.js";
import handleExternalLink from "./handle-external-link.js";
import * as AppMenu from "./menu.js";
import { _getServerSettings, _isOnline, _saveServerIcon } from "./request.js";
import { sentryInit } from "./sentry.js";
import { setAutoLaunch } from "./startup.js";
import { ipcMain, send } from "./typed-ipc-main.js";

import { NativeCaptureManager } from './native-capture';
import { JitsiManager } from './jitsi-manager';

let screenCaptureAddon: any = null;
let jitsiSDKAvailable = false;
let JitsiMeetElectron: any = null;


        
// В index.ts добавьте в начало файла:
import * as fs from 'fs';

// Создаем поток для записи логов
const preloadLogStream = fs.createWriteStream(
  path.join(process.cwd(), 'preload-debug.log'),
  { flags: 'a' } // append mode
);

// Затем обновите обработчик:
ipcMain.on("preload-log", (event, message: string) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Пишем в файл напрямую
  preloadLogStream.write(logMessage);
  
  // Также выводим в консоль
  console.log(`Preload Log: ${message}`);
  
  // И в electron-log
  log.info(`Preload Log: ${message}`);
});

// Настройка логирования
if (process.env.NODE_ENV === "development") {
  log.transports.file.level = "info";
  log.transports.console.level = "info"; // Включить консольный вывод
  log.transports.console.format = "[{h}:{i}:{s}] {text}"; // Формат логов
  autoUpdater.logger = log;
} else {
  log.transports.console.level = false
}

// Настройка автообновления
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// eslint-disable-next-line @typescript-eslint/naming-convention
const { GDK_BACKEND } = process.env;

// Инициализация Sentry для основного процесса
sentryInit();

let mainWindowState: windowStateKeeper.State;
let mainWindow: BrowserWindow;
let badgeCount: number;
let isQuitting = false;

// Переменные для управления горячей клавишей микрофона
let currentHotkey: string | null = null;
let originalMuteState: boolean | null = null;

type KeyName = 
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'DOT' | 'FORWARD SLASH'
  | 'SPACE';

const vKeyToName: { [key: number]: KeyName } = {
  // Латинские буквы (A–Z, соответствуют a–z)
  66: 'B',
  78: 'N',
  88: 'X',
  90: 'Z',
  // Дополнительные клавиши
  32: 'SPACE', // Пробел
  190: 'DOT',
  191: 'FORWARD SLASH'
};

try {
    const jitsiModule = require('@jitsi/electron-sdk');
    JitsiMeetElectron = jitsiModule.default || jitsiModule.JitsiMeetElectron || jitsiModule;
    jitsiSDKAvailable = true;
    log.info(`🎯[Jitsi SDK] Module loaded successfully, SDK is AVAILABLE`);
} catch (error: any) {
    jitsiSDKAvailable = false;
    log.error(`🎯[Jitsi SDK] Failed to load module: ${error.message}`);
    log.info(`🎯[Jitsi SDK] SDK is NOT AVAILABLE, iframe will be used`);
}

class CustomKeyboardListener extends GlobalKeyboardListener {
  public startListener(): Promise<void> {
    return this.start(); // Вызываем защищённый метод start
  }

  public stopListener(): void {
    this.stop(); // Вызываем защищённый метод stop
  }
}

function normalizeKey(key: string): string {
  // Преобразование кириллических букв в латинские эквиваленты
  const cyrillicToLatin: { [key: string]: string } = {
    'а': 'a', // Ф
    'б': 'b', // И
    'в': 'v', // Ц
    'г': 'g', // У
    'д': 'd', // В
    'е': 'e', // У
    'ё': 'e', // Ё (можно сопоставить с E)
    'ж': 'zh', // Ж (нет прямого эквивалента, используем zh)
    'з': 'z', // Я
    'и': 'i', // Ш
    'й': 'j', // Й
    'к': 'k', // Л
    'л': 'l', // Д
    'м': 'm', // Ь
    'н': 'n', // Т
    'о': 'o', // Щ
    'п': 'p', // З
    'р': 'r', // К
    'с': 's', // Ы
    'т': 't', // Е
    'у': 'u', // Г
    'ф': 'f', // А
    'х': 'h', // Р
    'ц': 'c', // С
    'ч': 'ch', // Ч (нет прямого эквивалента, используем ch)
    'ш': 'sh', // Ш (нет прямого эквивалента, используем sh)
    'щ': 'sch', // Щ (нет прямого эквивалента, используем sch)
    'ъ': 'hard_sign', // Ъ (нет прямого эквивалента)
    'ы': 'y', // Ы
    'ь': 'soft_sign', // Ь (нет прямого эквивалента)
    'э': 'e', // Э
    'ю': 'yu', // Ю (нет прямого эквивалента, используем yu)
    'я': 'ya', // Я (нет прямого эквивалента, используем ya)
  };

  let normalized = key.toLowerCase().replace("command", "meta");
  for (const [cyr, lat] of Object.entries(cyrillicToLatin)) {
    normalized = normalized.replace(cyr, lat);
  }
  return normalized;
}

const mainUrl = new URL("app/renderer/main.html", bundleUrl).href;

// Создаём маппинг keycode → имя клавиши
const keyboard = new CustomKeyboardListener();

const permissionCallbacks = new Map<number, (grant: boolean) => void>();
let nextPermissionCallbackId = 0;

const appIcon = path.join(publicPath, "resources/Icon");

const iconPath = (): string => {
  if (process.platform === "win32") {
    return appIcon + ".ico";
  } else if (process.platform === "darwin") {
    return appIcon + ".png";
  } else {
    return appIcon + ".png";
  }
};

const toggleApp = (): void => {
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
    mainWindow.show();
  } else {
    mainWindow.hide();
  }
};

function setFeaturesApp() {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

async function createMainWindow(): Promise<BrowserWindow> {
    setFeaturesApp();
    mainWindowState = windowStateKeeper({
        defaultWidth: 1100,
        defaultHeight: 720,
        path: `${app.getPath("userData")}/config`,
    });

    let icon = iconPath();

    const win = new BrowserWindow({
        title: "RM",
        icon: icon,
        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,
        minWidth: 500,
        minHeight: 400,
        webPreferences: {
            preload: path.join(bundlePath, "renderer.js"),
            sandbox: false,
            webviewTag: true,
            nodeIntegration: false,
            contextIsolation: true
        },
        show: false,
        backgroundColor: '#333',
    });

    remoteMain.enable(win.webContents);

    // КРИТИЧНО: Устанавливаем preload для ВСЕХ webContents включая Zulip
    win.webContents.on('will-attach-webview', (event: Electron.Event, webPreferences: Electron.WebPreferences, params: any) => {
        log.info(`Main: WebView создается с URL: ${params.src}`);
        
        // ИСПРАВЛЕНИЕ: Устанавливаем preload для всех webview
        const preloadPath = path.join(bundlePath, "preload.js");
        webPreferences.preload = preloadPath;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        
        // КРИТИЧНО: Добавляем для Zulip
        if (params.src && params.src.includes('joinrm-svz')) {
            log.info(`Main: Устанавливаем preload для Zulip: ${preloadPath}`);
            webPreferences.preload = preloadPath;
        }
        
        log.info(`Main: Webview preload установлен: ${preloadPath}`);
    });

    // НОВОЕ: Слушаем создание новых webContents
    app.on('web-contents-created', (event, contents) => {
      contents.on('console-message', (event, level, message, line, sourceId) => {
          if (message.includes('[NativeCapture]') || message.includes('[electron_bridge]')) {
              log.info(`Jitsi Console: ${message}`);
          }
      });
      
      // Слушаем IPC сообщения через executeJavaScript bridge
      contents.on('did-finish-load', () => {
          const url = contents.getURL();
          
          // Если это Jitsi окно
          if (url && url.includes('jitsi')) {
              contents.executeJavaScript(`
                  window.addEventListener('message', (event) => {
                      if (event.data.type === 'ELECTRON_BRIDGE_EVENT') {
                          // Пересылаем в main process через console.log с маркером
                          console.log('[ELECTRON_BRIDGE_FORWARD]' + JSON.stringify(event.data));
                      }
                  });
              `);
          }
      });
  });

    const mainHtmlPath = path.join(__dirname, 'app/renderer/main.html');
    const mainUrl = `file://${mainHtmlPath}`;

    await win.loadURL(mainUrl).then(() => {
        console.log('✅ Окно создано!');
        if (ConfigUtil.getConfigItem('startMinimized', false)) {
            win.hide();
        } else {
            win.show();
        }
    });

    win.on("close", (event) => {
      if (ConfigUtil.getConfigItem("quitOnClose", false)) {
        app.quit();
    }

    if (!isQuitting && !shouldQuitForUpdate()) {
      event.preventDefault();

      if (process.platform === "darwin") {
        if (win.isFullScreen()) {
          win.setFullScreen(false);
          win.once("leave-full-screen", () => {
            app.hide();
          });
        } else {
          app.hide();
        }
      } else {
        win.hide();
      }
    }
  });

  win.on("enter-full-screen", () => {
    send(win.webContents, "enter-fullscreen");
  });

  win.on("leave-full-screen", () => {
    send(win.webContents, "leave-fullscreen");
  });

  win.webContents.on("will-navigate", (event) => {
    if (event) {
      send(win.webContents, "destroytray");
    }
  });

  win.webContents.on('will-attach-webview', (event: Electron.Event, webPreferences: Electron.WebPreferences, params: any) => {
    log.info(`Main: WebView создается с URL: ${params.src}`);
    
    // ВАЖНО: Устанавливаем правильный preload для webview
    const preloadPath = path.join(bundlePath, "preload.js");
    webPreferences.preload = preloadPath;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    
    log.info(`Main: Webview preload установлен: ${preloadPath}`);
    log.info(`Main: Preload файл существует: ${require('fs').existsSync(preloadPath)}`);
  });

  win.setTitle("Цифровые технологии РМ");

  mainWindowState.manage(win);
  return win;
}

(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  setFeaturesApp();
  app.disableHardwareAcceleration();
  await app.whenReady();

  try {
    const possiblePaths = [
        path.join(__dirname, 'native-addon.node'),
        path.join(__dirname, '..', 'dist-electron', 'native-addon.node'),
        path.join(process.cwd(), 'dist-electron', 'native-addon.node'),
        '/Users/sg12/zulip-desktop/dist-electron/native-addon.node'
    ];
    
    let addonPath: string | null = null;
    for (const testPath of possiblePaths) {
        if (require('fs').existsSync(testPath)) {
        addonPath = testPath;
        break;
        }
    }
    
    if (!addonPath) {
        throw new Error(`Native addon not found in any of: ${possiblePaths.join(', ')}`);
    }
    
    log.info(`Loading native addon from: ${addonPath}`);
    screenCaptureAddon = require(addonPath);
    log.info(`✅ Native addon loaded successfully`);

    if (screenCaptureAddon.testBasic) {
        const result = screenCaptureAddon.testBasic();
        log.info(`Basic test result: ${result}`);
    }
    
    // Тест addon
    const testResult = screenCaptureAddon.testMethod();
    log.info(`✅ Native addon test result: ${testResult}`);
    
    // Проверяем наличие метода
    if (typeof screenCaptureAddon.getAvailableSources === 'function') {
        log.info("✅ Native addon has getAvailableSources method");
    } else {
        log.warn("⚠️ Native addon missing getAvailableSources method");
    }
    
  } catch (error: any) {
        log.error(`❌ Failed to load native addon: ${error.message}`);
        screenCaptureAddon = null;
  }

  const nativeCaptureManager = new NativeCaptureManager(screenCaptureAddon);
  const jitsiManager = new JitsiManager(
    nativeCaptureManager,
    bundlePath,
    iconPath(),
    {
        videoQuality: 'MEDIUM',  // 720p для экономии ресурсов
        useHybridMode: true,
        enableDebugUI: process.env.NODE_ENV === 'development'
    }
  );

  

  // 2. ЗАТЕМ создаем сессию
  const ses = session.fromPartition("persist:webviewsession");
  ses.setUserAgent(`ZulipElectron/${app.getVersion()} ${ses.getUserAgent()}`);

  // 3. РЕГИСТРИРУЕМ ВСЕ IPC ОБРАБОТЧИКИ ДО СОЗДАНИЯ ОКНА

  let isNativeCapturing: boolean = false;
  let frameCollectionInterval: NodeJS.Timeout | null = null;

  ipcMain.handle("get-server-settings", async (event, domain: string) =>
    _getServerSettings(domain, ses),
  );

  ipcMain.handle("save-server-icon", async (event, url: string) =>
    _saveServerIcon(url, ses),
  );

  ipcMain.handle("is-online", async (event, url: string) =>
    _isOnline(url, ses),
  );

  function sendEventToZulip(eventName: string, data: any): void {
      const allContents = webContents.getAllWebContents();
      for (const content of allContents) {
          const url = content.getURL();
          if (url && url.includes('joinrm-svz')) {
              content.executeJavaScript(`
                  (function() {
                      // Отправляем событие через electron_bridge
                      if (window.electron_bridge && window.electron_bridge.emit_event) {
                          window.electron_bridge.emit_event('${eventName}', ${JSON.stringify(data)});
                          console.log('[Electron->Zulip] Sent event: ${eventName}');
                      }
                      
                      // Дополнительно обрабатываем специальные события
                      if ('${eventName}' === 'jitsi-loading-started') {
                          // Показываем индикатор загрузки в Zulip UI
                          const indicator = document.createElement('div');
                          indicator.id = 'jitsi-loading-indicator';
                          indicator.style.cssText = \`
                              position: fixed;
                              top: 50%;
                              left: 50%;
                              transform: translate(-50%, -50%);
                              background: rgba(0, 0, 0, 0.8);
                              color: white;
                              padding: 20px 40px;
                              border-radius: 10px;
                              z-index: 10000;
                              font-size: 16px;
                              display: flex;
                              align-items: center;
                              gap: 15px;
                          \`;
                          indicator.innerHTML = \`
                              <div style="
                                  width: 24px;
                                  height: 24px;
                                  border: 3px solid rgba(255, 255, 255, 0.3);
                                  border-top-color: white;
                                  border-radius: 50%;
                                  animation: spin 1s linear infinite;
                              "></div>
                              <style>
                                  @keyframes spin {
                                      to { transform: rotate(360deg); }
                                  }
                              </style>
                              <span>${data.message || 'Загрузка...'}</span>
                          \`;
                          document.body.appendChild(indicator);
                      } else if ('${eventName}' === 'jitsi-loading-finished') {
                          // Убираем индикатор загрузки
                          const indicator = document.getElementById('jitsi-loading-indicator');
                          if (indicator) {
                              indicator.remove();
                          }
                      }
                  })();
              `).catch(err => {
                  log.error(`Failed to send event to Zulip: ${err.message}`);
              });
              break;
          }
      }
  }

  function createSourceThumbnail(source: any): string {
    const colors: { [key: string]: string } = {
        screen: '#4CAF50',
        display: '#4CAF50', 
        window: '#2196F3',
        application: '#FF9800'
    };
    
    const color = colors[source.type] || '#9E9E9E';
    const icon = source.type === 'screen' || source.type === 'display' ? '🖥️' : '🪟';
    
    const svg = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="300" height="200" fill="${color}"/>
        <text x="150" y="80" font-size="50" text-anchor="middle" fill="white">${icon}</text>
        <text x="150" y="130" font-size="16" text-anchor="middle" fill="white" font-weight="bold">
        ${(source.name || 'Unknown').replace(/[<>&"']/g, '')}
        </text>
        ${source.appName ? `
        <text x="150" y="155" font-size="14" text-anchor="middle" fill="white" opacity="0.9">
            ${source.appName.replace(/[<>&"']/g, '')}
        </text>
        ` : ''}
        <rect x="20" y="180" width="260" height="3" rx="1.5" fill="white" opacity="0.2"/>
        <rect x="20" y="180" width="130" height="3" rx="1.5" fill="white" opacity="0.6"/>
    </svg>`;
    
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }


  ipcMain.handle("get-desktop-sources", async () => {
    try {
        log.info("🎯[NativeCapture] Getting desktop sources...");
        
        let formattedSources = [];
        let sourceType = 'unknown';
        
        // Создаем маппинг для сохранения оригинальных ID
        const sourceIdMapping = new Map();
        
        // Получаем источники из native addon
        if (screenCaptureAddon && typeof screenCaptureAddon.getAvailableSources === 'function') {
        try {
            const nativeSources = await screenCaptureAddon.getAvailableSources();
            log.info(`🎯[NativeCapture] Got ${nativeSources.length} native sources`);
            
            if (nativeSources.length > 0) {
            sourceType = 'native';
            
            // Логируем первые несколько источников для отладки
            nativeSources.slice(0, 3).forEach((source, i) => {
                log.info(`  Native source ${i}: id=${source.id}, name=${source.name}, type=${source.type}`);
            });
            
            formattedSources = nativeSources.map((source, index) => {
                const type = source.type === 'window' ? 'window' : 'screen';
                
                // ВАЖНО: Сохраняем оригинальный ID от native addon
                const originalId = source.id;
                
                // Создаем ID в формате Electron, но сохраняем оригинальный ID
                let formattedId;
                if (originalId && !isNaN(Number(originalId))) {
                // Если ID - число, используем его напрямую
                formattedId = `${type}:${originalId}:0`;
                } else if (originalId) {
                // Если ID - строка (например, com.microsoft.VSCode)
                // Генерируем числовой ID для Electron формата
                const numericId = Math.abs(originalId.toString().split('').reduce((a, b) => {
                    a = ((a << 5) - a) + b.charCodeAt(0);
                    return a & a;
                }, 0));
                formattedId = `${type}:${numericId}:0`;
                
                // Сохраняем маппинг
                sourceIdMapping.set(formattedId, originalId);
                } else {
                // Fallback - генерируем случайный ID
                const randomId = Math.floor(100000 + Math.random() * 900000);
                formattedId = `${type}:${randomId}:0`;
                }
                
                log.info(`  Formatted: ${formattedId} -> original: ${originalId}`);
                
                return {
                id: formattedId,
                name: `🎯 ${source.name || 'Source ' + index}`,
                thumbnail: { 
                    dataUrl: createSourceThumbnail(source) 
                },
                isNative: true,
                sourceType: 'native',
                originalId: originalId, // Сохраняем оригинальный ID
                originalType: source.type
                };
            });
            
            // Сохраняем маппинг глобально для последующего использования
            global.nativeSourceMapping = sourceIdMapping;
            
            log.info(`🎯[NativeCapture] Created source mapping with ${sourceIdMapping.size} entries`);
            }
            
        } catch (error: any) {
            log.error(`🎯[NativeCapture] Error getting native sources: ${error.message}`);
        }
        }
        
        // Если нет native источников, используем Electron
        if (formattedSources.length === 0) {
        log.info("No native sources, using Electron fallback");
        const electronSources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 300, height: 200 }
        });
        
        formattedSources = electronSources.map(source => ({
            id: source.id,
            name: source.name,
            thumbnail: {
            dataUrl: source.thumbnail.toDataURL()
            },
            isNative: false
        }));
        }
        
        return formattedSources;
        
    } catch (error: any) {
        log.error(`🎯[NativeCapture] Error: ${error.message}`);
        return [];
    }
    });


  ipcMain.handle("jitsi-connect-with-zulip-config", async (event, options) => {
      log.info("🎯[Jitsi] Connecting with Zulip config...");
      log.info(`🎯[Jitsi] Options received: ${JSON.stringify(options)}`);
      log.info(`🎯[Jitsi] SDK Available: ${jitsiSDKAvailable}`);

      try {
          // ВАЖНО: Если SDK недоступен, сразу возвращаем fallback
          if (!jitsiSDKAvailable) {
              log.info("🎯[Jitsi] SDK not available, returning fallback immediately");
              return { 
                  success: false, 
                  error: "Jitsi SDK not installed",
                  fallbackToBrowser: true,
                  sdkNotAvailable: true
              };
          }

          // Если SDK доступен, НЕ разрешаем fallback
          log.info("🎯[Jitsi] SDK is available, attempting to create window...");
          
          // Добавляем индикатор загрузки в Zulip
          sendEventToZulip('jitsi-loading-started', {
              message: 'Запуск Jitsi конференции...'
          });

          // Формируем конфигурацию с нужными параметрами
          const jitsiConfig = {
              prejoinConfig: { enabled: false },
              disableSimulcast: true,
              startWithVideoMuted: true,
              startWithAudioMuted: false,
              disableAudioLevels: false,
              stereo: false,
              echoCancellation: true,
              noiseSuppression: true,
              highpassFilter: true,
              autoGainControl: true,
              enableLipSync: false,
              audioProcessing: {
                  autoGainControl: true,
                  echoCancellation: true,
                  noiseSuppression: true,
                  highpassFilter: true
              },
              hideConferenceSubject: true,
              deeplinking: {
                  disabled: true
              },
              resolution: 720,
              disableRemoteMute: true,
              disableKick: true,
              disableGrantModerator: true,
              disablePrivateChat: true,
              disableSelfViewSettings: true,
              disableLocalVideoFlip: true,
              disableLocalStats: true,
              disableAVModeration: true,
              disableInviteFunctions: true,
              participantsPane: {
                  hideMoreActionsButton: true
              },
              breakoutRooms: {
                  hideMoreActionsButton: true
              },
              filmstrip: {
                  disableStageFilmstrip: true,
                  disableResizable: true
              },
              // Logging настройки
              apiLogLevels: ['error'],
              logging: {
                  defaultLogLevel: 'error',
                  loggers: {
                      'modules/RTC/TraceablePeerConnection.js': 'error',
                      'modules/statistics/CallStats.js': 'error',
                      'modules/xmpp/strophe.util.js': 'error',
                      'modules/statistics/LocalStatsCollector.js': 'error'
                  }
              }
          };

          const interfaceConfig = {
              DISABLE_VIDEO_BACKGROUND: true,
              DISABLE_DOMINANT_SPEAKER_INDICATOR: true,
              TOOLBAR_BUTTONS: [
                  'camera',
                  'desktop',
                  'microphone',
                  'settings',
                  'fullscreen',
                  'hangup'
              ]
          };

          // Используем JitsiManager для создания окна с конфигурацией
          const result = await jitsiManager.createWindow({
              roomName: options.roomName || '',
              serverUrl: options.serverUrl || 'https://jitsi-connectrm.ru',
              displayName: options.userInfo?.displayName || 'Guest',
              email: options.userInfo?.email || '',
              avatarUrl: options.userInfo?.avatarURL || '',
              jwt: options.jwt || '',
              configOverwrite: jitsiConfig,
              interfaceConfigOverwrite: interfaceConfig
          });
          
          if (result.success) {
              log.info(`🎯[Jitsi] Conference window created successfully`);
              
              // Убираем индикатор загрузки
              sendEventToZulip('jitsi-loading-finished', {
                  success: true
              });
              
              // Отправляем подтверждение обратно в Zulip
              setTimeout(() => {
                  sendEventToZulip('jitsi-conference-ready', {
                      success: true,
                      roomName: options.roomName,
                      usingSDK: true
                  });
              }, 1000);
              
              // ВАЖНО: НЕ возвращаем fallbackToBrowser при успехе
              return {
                  success: true,
                  usingSDK: true
              };
          } else {
              // Если создание окна не удалось, но SDK есть - пробуем еще раз
              log.error(`🎯[Jitsi] Failed to create window, but SDK is available`);
              
              // Убираем индикатор загрузки
              sendEventToZulip('jitsi-loading-finished', {
                  success: false,
                  error: result.error
              });
              
              // ВАЖНО: НЕ разрешаем fallback, если SDK установлен
              return { 
                  success: false, 
                  error: result.error || "Failed to create Jitsi window",
                  fallbackToBrowser: false, // Запрещаем fallback
                  retryable: true // Указываем, что можно повторить попытку
              };
          }
          
      } catch (error: any) {
          log.error(`🎯[Jitsi] Error: ${error.message}`);
          
          // Убираем индикатор загрузки
          sendEventToZulip('jitsi-loading-finished', {
              success: false,
              error: error.message
          });
          
          // Если SDK установлен, НЕ разрешаем fallback даже при ошибке
          if (jitsiSDKAvailable) {
              log.info("🎯[Jitsi] Error occurred but SDK is available, NOT allowing fallback");
              return { 
                  success: false, 
                  error: error.message,
                  fallbackToBrowser: false, // Запрещаем fallback
                  retryable: true
              };
          } else {
              // Только если SDK точно недоступен
              return { 
                  success: false, 
                  error: error.message,
                  fallbackToBrowser: true,
                  sdkNotAvailable: true
              };
          }
      }
  });

  // Добавляем обработчик для проверки статуса SDK
  ipcMain.handle("check-jitsi-sdk-status", async () => {
      log.info(`🎯[Jitsi] SDK Status check: ${jitsiSDKAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
      
      return {
          sdkAvailable: jitsiSDKAvailable,
          jitsiManagerReady: !!jitsiManager,
          message: jitsiSDKAvailable 
              ? "Jitsi SDK установлен и готов к использованию" 
              : "Jitsi SDK не установлен, будет использован iframe"
      };
  });

  // Добавляем обработчик для повторной попытки
  ipcMain.handle("retry-jitsi-connection", async (event, options) => {
      log.info("🎯[Jitsi] Retrying connection...");
      
      if (!jitsiSDKAvailable) {
          return { 
              success: false, 
              error: "Jitsi SDK not available",
              fallbackToBrowser: true 
          };
      }
      
      // Ждем немного перед повторной попыткой
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Повторяем попытку создания окна
      return ipcMain.handle("jitsi-connect-with-zulip-config", event, options);
  });

  // Обработчики событий от Jitsi окна
  ipcMain.on('jitsi-api-ready', (event, data) => {
      log.info(`🎯[Jitsi] API ready in window: ${JSON.stringify(data)}`);
      sendEventToZulip('jitsi-api-ready', data);
  });

  ipcMain.on('jitsi-conference-joined', () => {
      log.info(`🎯[Jitsi] User joined conference`);
      sendEventToZulip('jitsi-conference-joined', {});
  });

  ipcMain.on('jitsi-conference-left', () => {
      log.info(`🎯[Jitsi] User left conference`);
      sendEventToZulip('jitsi-conference-left', {});
  });

  ipcMain.on('electron-bridge-event', async (event, data) => {
    log.info(`Main: electron_bridge event: ${data.event}`);
    
    if (data.event === 'requestDesktopSources') {
        try {
            // Используем NativeCaptureManager
            const sources = await nativeCaptureManager.getSources();
            
            log.info(`🔍 Got ${sources.length} sources`);
            
            // Отправляем в Jitsi окно если оно есть
            const jitsiStatus = await jitsiManager.getStatus();
            if (jitsiStatus.hasWindow) {
                await jitsiManager.sendSourcesToWindow(sources);
            }
            
        } catch (error: any) {
            log.error(`🔍 Error: ${error.message}`);
        }
    }
  });

  ipcMain.on('ipc-invoke', async (event, data) => {
      log.info(`Main: Synthetic IPC invoke: ${data.channel}`);
      
      try {
          let result;
          
          // Роутинг к существующим обработчикам
          if (data.channel === 'jitsi-connect-with-zulip-config') {
              result = await ipcMain.handle(data.channel, event, ...data.args);
          } else if (data.channel === 'test-zulip-bridge') {
              result = await ipcMain.handle(data.channel, event, ...data.args);
          } else {
              throw new Error(`Unknown channel: ${data.channel}`);
          }
          
          // Отправляем ответ обратно
          event.sender.executeJavaScript(`
              window.dispatchEvent(new CustomEvent('ipc-response', {
                  detail: {
                      requestId: ${data.requestId},
                      data: ${JSON.stringify(result)},
                      error: null
                  }
              }));
          `);
          
      } catch (error) {
          log.error(`Main: IPC invoke error: ${error.message}`);
          
          event.sender.executeJavaScript(`
              window.dispatchEvent(new CustomEvent('ipc-response', {
                  detail: {
                      requestId: ${data.requestId},
                      data: null,
                      error: "${error.message}"
                  }
              }));
          `);
      }
  });


  // Тестовый обработчик для проверки связи с Zulip
  ipcMain.handle("test-zulip-bridge", async () => {
      log.info("🧪[Test] Testing Zulip bridge...");
      
      const result = {
          zulipFound: false,
          currentUserName: 'Unknown',
          currentUserEmail: 'Unknown', 
          hasElectronBridge: false,
          hasIpcRenderer: false,
          totalWebContents: 0,
          zulipUrl: '',
          error: null
      };
      
      try {
          const allContents = webContents.getAllWebContents();
          result.totalWebContents = allContents.length;
          
          for (const content of allContents) {
              const url = content.getURL();
              
              if (url && url.includes('joinrm-svz')) {
                  result.zulipFound = true;
                  result.zulipUrl = url;
                  log.info(`🧪[Test] Found Zulip at: ${url}`);
                  
                  try {
                      const testResult = await content.executeJavaScript(`
                          (function() {
                              const hasElectronBridge = typeof window.electron_bridge !== 'undefined';
                              const hasIpcRenderer = typeof window.ipcRenderer !== 'undefined';
                              
                              let userName = 'Unknown';
                              let userEmail = 'Unknown';
                              
                              if (typeof current_user !== 'undefined' && current_user) {
                                  userName = String(current_user.full_name || 'Unknown');
                                  userEmail = String(current_user.email || 'Unknown');
                              }
                              
                              return {
                                  hasElectronBridge: hasElectronBridge,
                                  hasIpcRenderer: hasIpcRenderer,
                                  userName: userName,
                                  userEmail: userEmail,
                                  location: window.location.href,
                                  
                                  // Детали API
                                  electronBridgeOk: hasElectronBridge && 
                                      typeof window.electron_bridge.on_event === 'function' &&
                                      typeof window.electron_bridge.send_event === 'function',
                                      
                                  ipcRendererOk: hasIpcRenderer &&
                                      typeof window.ipcRenderer.invoke === 'function' &&
                                      typeof window.ipcRenderer.send === 'function'
                              };
                          })();
                      `);
                      
                      result.currentUserName = testResult.userName;
                      result.currentUserEmail = testResult.userEmail;
                      result.hasElectronBridge = testResult.electronBridgeOk;
                      result.hasIpcRenderer = testResult.ipcRendererOk;
                      
                      log.info(`🧪[Test] User: ${testResult.userName}, Bridge: ${testResult.electronBridgeOk}, IPC: ${testResult.ipcRendererOk}`);
                      
                  } catch (execError: any) {
                      log.error(`🧪[Test] Error executing in Zulip: ${execError.message}`);
                      result.error = execError.message;
                  }
                  break;
              }
          }
          
          log.info(`🧪[Test] Final result: ${JSON.stringify(result)}`);
          return result;
          
      } catch (error: any) {
          log.error(`🧪[Test] Error: ${error.message}`);
          result.error = error.message;
          return result;
      }
  });

  // Обработчик запуска нативного захвата
  ipcMain.handle("start-native-capture", async (event, sourceId: string) => {
    return nativeCaptureManager.startCapture(sourceId);
  });

  // Обработчик остановки захвата
  ipcMain.handle("stop-native-capture", async () => {
    return nativeCaptureManager.stopCapture();
  });

  // Обработчик получения статуса захвата
  ipcMain.handle("get-capture-status", async () => {
    return nativeCaptureManager.getStatus();
  });

  ipcMain.on("focus-app", () => {
    mainWindow.show();
  });

  ipcMain.on("quit-app", () => {
    log.info("Main: Получено событие quit-app, закрытие приложения...");
    isQuitting = true;
    app.quit();
  });

  ipcMain.on("reload-full-app", () => {
    mainWindow.reload();
    send(page, "destroytray");
  });

  ipcMain.on("forward-message", (event, channel, ...args) => {
    log.info(`Main: Получено forward-message с каналом: ${channel}`);
    webContents.getAllWebContents().forEach(content => {
      content.send("forward-message", channel, ...args);
    });
  });

  // Обработчик jitsi-log-event
  ipcMain.on('jitsi-log-event', (event, logData) => {
    log.info(`Jitsi Log [${logData.level}]: ${logData.message}`);
    console.log(`Jitsi Log [${logData.level}]: ${logData.message}`);
  });


  ipcMain.on("preload-log", (event, message: string) => {
    log.info(`Preload Log: ${message}`);
    console.log(`Preload Log: ${message}`);
  });

  // Обработчик для установки горячей клавиши микрофона
  ipcMain.on("walkie-talkie-status", (event, status: unknown) => {
    log.info(`Main: Получено событие walkie-talkie-status: ${JSON.stringify(status)}`);
    if (typeof status !== "object" || status === null || !("enabled" in status) || !("key" in status)) {
      log.error(`Main: Некорректный формат данных для walkie-talkie-status: ${JSON.stringify(status)}`);
      return;
    }
  
    const { enabled, key: rawKey } = status as WalkieTalkieStatus;
    if (typeof enabled !== "boolean" || typeof rawKey !== "string") {
      log.error(`Main: Некорректные типы в walkie-talkie-status: enabled=${typeof enabled}, key=${typeof rawKey}`);
      return;
    }
  
    // Игнорируем пустые или некорректные ключи
    if (!rawKey || rawKey.trim() === '') {
      log.warn(`Main: Пустой или некорректный ключ: ${rawKey}`);
      return;
    }
  
    if (currentHotkey) {
      keyboard.stopListener();
      log.info(`Main: Остановлен node-global-key-listener для предыдущей клавиши: ${currentHotkey}`);
    }
  
    const key = normalizeKey(rawKey);
    log.info(`Main: Преобразован ключ из ${rawKey} в ${key}`);
  
    const validAccelerators = /^[a-z0-9]+$/;
    const validCombo = /^((ctrl|alt|shift|meta)\+)+[a-z0-9]+$/i;
    if (!validAccelerators.test(key) && !validCombo.test(key)) {
      log.error(`Main: Некорректный формат горячей клавиши: ${key}`);
      return;
    }
  
    currentHotkey = key;
    log.info(`Main: Установка горячей клавиши микрофона: ${key}`);
  
    keyboard.startListener().then(() => {
      log.info(`Main: node-global-key-listener запущен для клавиши: ${key}`);
    }).catch(err => {
      log.error(`Main: Ошибка запуска node-global-key-listener: ${err}`);
    });
  
    keyboard.addListener((e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
      const parts = key.split('+').map(p => p.toLowerCase());
      const mainKey = parts.pop()!;
      
      log.info(`Main: символ: ${e.name}`);
      log.info(`Main: код: ${e.vKey}`);
      const pressedKeyName = vKeyToName[e.vKey] || '';
  
      // Проверяем, является ли pressedKeyName допустимым ключом
      if (!(pressedKeyName in down)) {
        return;
      }
  
      // Преобразуем mainKey в верхний регистр для соответствия IGlobalKeyDownMap
      const normalizedMainKey = mainKey.toUpperCase() as KeyName;
  
      if (pressedKeyName !== normalizedMainKey) {
        return;
      }
      log.info(`Main: проверка: ${down[pressedKeyName]}`);
      if (down[pressedKeyName]) {
        log.info(`Main: Нажата горячая клавиша: ${key}`);
  
        const allWebContents = webContents.getAllWebContents();
        const activeWebContents = allWebContents.find((content) => {
          const url = content.getURL();
          log.info(`Main: Проверка WebContents URL: ${url}, ID: ${content.id}`);
          return url.includes("connectrm-svz.ru") || url.includes("joinrm-svz.ru");
        });
  
        if (!activeWebContents) {
          log.warn("Main: Не найден WebContents с URL connectrm-svz.ru или joinrm-svz.ru");
          return;
        }
  
        log.info(`Main: Выбран WebContents ID: ${activeWebContents.id}, URL: ${activeWebContents.getURL()}`);
        log.info(`Main: Микрофон переключен в состояние: ${true}`);
        activeWebContents.send("toggle-walkie-talkie", true);
      } else {
        log.info(`Main: Отпущена горячая клавиша: ${key}`);
        const allWebContents = webContents.getAllWebContents();
          const activeWebContents = allWebContents.find((content) => {
            const url = content.getURL();
            log.info(`Main: Проверка WebContents URL (отпускание): ${url}, ID: ${content.id}`);
            return url.includes("connectrm-svz.ru") || url.includes("joinrm-svz.ru");
          });
  
          if (!activeWebContents) {
            log.warn("Main: Не найден WebContents с URL connectrm-svz.ru или joinrm-svz.ru (отпускание)");
            return;
          }
          log.info(`Main: Микрофон восстановлен в состояние: ${false}`);
          activeWebContents.send("toggle-walkie-talkie", false);
      }
    });
  });

  if (process.env.GDK_BACKEND !== GDK_BACKEND) {
    console.warn(
      "Возвращаем GDK_BACKEND для обхода проблемы https://github.com/electron/electron/issues/28436",
    );
    if (GDK_BACKEND === undefined) {
      delete process.env.GDK_BACKEND;
    } else {
      process.env.GDK_BACKEND = GDK_BACKEND;
    }
  }

  app.setAppUserModelId("org.rm.rm-electron");
  remoteMain.initialize();

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
    }
  });

  

  mainWindow = await createMainWindow();
  console.log("✅ Окно создано!");

  if (process.platform !== "darwin") {
    const shouldHideMenu = ConfigUtil.getConfigItem("autoHideMenubar", false);
    mainWindow.autoHideMenuBar = shouldHideMenu;
    mainWindow.setMenuBarVisibility(!shouldHideMenu);
  }

  const page = mainWindow.webContents;

  page.on("dom-ready", () => {
    if (ConfigUtil.getConfigItem("startMinimized", false)) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  page.once("did-frame-finish-load", () => {
    if (ConfigUtil.getConfigItem("autoUpdate", true)) {
      appUpdater().catch((error) => {
        log.error("Ошибка при проверке обновлений:", error);
      });
    }
  });

})();


app.on("before-quit", () => {
  isQuitting = true;
  // Очищаем горячую клавишу при выходе
  if (currentHotkey) {
    keyboard.stopListener();
    log.info(`Main: Горячая клавиша ${currentHotkey} удалена при выходе`);
  }
});

autoUpdater.on("checking-for-update", () => {
  log.info("Проверка обновлений...");
});

autoUpdater.on("update-available", (info) => {
  log.info(`Доступно обновление: v${info.version}`);
  mainWindow?.webContents.send("update_available", info.version);
});

autoUpdater.on("update-not-available", () => {
  log.info("Обновлений нет.");
});

autoUpdater.on("download-progress", (progress) => {
  log.info(`Прогресс загрузки: ${progress.percent}%`);
  mainWindow?.webContents.send("update_progress", progress.percent);
});

autoUpdater.on("update-downloaded", () => {
  log.info("Обновление загружено.");
  mainWindow?.webContents.send("update_downloaded");
});

autoUpdater.on("error", (err) => {
  log.error("Ошибка обновления:", err);
  mainWindow?.webContents.send("update_error", err.message);
});

ipcMain.on("restart_app", () => {
  autoUpdater.quitAndInstall();
});

process.on("uncaughtException", (error) => {
  console.error(error);
  console.error(error.stack);
});