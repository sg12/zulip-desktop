import type { WebContents } from "electron/main";
import fs from "node:fs";
import process from "node:process";

import * as remote from "@electron/remote";
import { app, dialog } from "@electron/remote";

import * as ConfigUtil from "../../../common/config-util.js";
import { type Html, html } from "../../../common/html.js";
import * as t from "../../../common/translation-util.js";
import type { RendererMessage } from "../../../common/typed-ipc.js";
import type { TabRole } from "../../../common/types.js";
import preloadCss from "../../css/preload.css?raw";
import { ipcRenderer } from "../typed-ipc-renderer.js";
import * as SystemUtil from "../utils/system-util.js";

import { generateNodeFromHtml } from "./base.js";
import { contextMenu } from "./context-menu.js";

const shouldSilentWebview = ConfigUtil.getConfigItem("silent", false);

type WebViewProperties = {
  $root: Element;
  rootWebContents: WebContents;
  index: number;
  tabIndex: number;
  url: string;
  role: TabRole;
  isActive: () => boolean;
  switchLoading: (loading: boolean, url: string) => void;
  onNetworkError: (index: number) => void;
  preload?: string;
  onTitleChange: () => void;
  hasPermission?: (origin: string, permission: string) => boolean;
  unsupportedMessage?: string;
};

export default class WebView {
  static templateHtml(properties: WebViewProperties): Html {
    return html`
      <div class="webview-pane">
        <div
          class="webview-unsupported"
          ${properties.unsupportedMessage === undefined ? html`hidden` : html``}
        >
          <span class="webview-unsupported-message"
            >${properties.unsupportedMessage ?? ""}</span
          >
          <span class="webview-unsupported-dismiss">×</span>
        </div>
        <webview
          allowpopups
          allow="microphone; camera;"
          data-tab-id="${properties.tabIndex}"
          src="${properties.url}"
          ${properties.preload === undefined
            ? html``
            : html`preload="${properties.preload}"`}
          partition="temp:incognito"
          allowpopups
          webpreferences="nodeIntegrationInSubFrames=true,contextIsolation=false"
        >
        </webview>
      </div>
    `;
  }

  static async create(properties: WebViewProperties): Promise<WebView> {
    const $pane = generateNodeFromHtml(
      WebView.templateHtml(properties),
    ) as HTMLElement;
    properties.$root.append($pane);

    const $webview: HTMLElement = $pane.querySelector(":scope > webview")!;
    await new Promise<void>((resolve) => {
      $webview.addEventListener(
        "did-attach",
        () => {
          resolve();
        },
        true,
      );
    });

    // Work around https://github.com/electron/electron/issues/26904
    function getWebContentsIdFunction(
      this: undefined,
      selector: string,
    ): number {
      return document
        .querySelector<Electron.WebviewTag>(selector)!
        .getWebContentsId();
    }

    const selector = `webview[data-tab-id="${CSS.escape(
      `${properties.tabIndex}`,
    )}"]`;
    const webContentsId: unknown =
      await properties.rootWebContents.executeJavaScript(
        `(${getWebContentsIdFunction.toString()})(${JSON.stringify(selector)})`,
      );
    if (typeof webContentsId !== "number") {
      throw new TypeError("Failed to get WebContents ID");
    }

    return new WebView(properties, $pane, $webview, webContentsId);
  }

  badgeCount = 0;
  loading = true;
  private customCss: string | false | null;
  private readonly $webviewsContainer: DOMTokenList;
  private readonly $unsupported: HTMLElement;
  private readonly $unsupportedMessage: HTMLElement;
  private readonly $unsupportedDismiss: HTMLElement;
  private unsupportedDismissed = false;

  private constructor(
    readonly properties: WebViewProperties,
    private readonly $pane: HTMLElement,
    private readonly $webview: HTMLElement,
    readonly webContentsId: number,
  ) {
    this.customCss = ConfigUtil.getConfigItem("customCSS", null);
    this.$webviewsContainer = document.querySelector(
      "#webviews-container",
    )!.classList;
    this.$unsupported = $pane.querySelector(".webview-unsupported")!;
    this.$unsupportedMessage = $pane.querySelector(
      ".webview-unsupported-message",
    )!;
    this.$unsupportedDismiss = $pane.querySelector(
      ".webview-unsupported-dismiss",
    )!;

    this.registerListeners();
  }

  destroy(): void {
    this.$pane.remove();
  }

  getWebContents(): WebContents {
    return remote.webContents.fromId(this.webContentsId)!;
  }

  showNotificationSettings(): void {
    this.send("show-notification-settings");
  }

  focus(): void {
    this.$webview.focus();
    // Work around https://github.com/electron/electron/issues/31918
    this.$webview.shadowRoot?.querySelector("iframe")?.focus();
  }

  hide(): void {
    this.$pane.classList.remove("active");
  }

  load(): void {
    this.show();
  }

  zoomIn(): void {
    this.getWebContents().zoomLevel += 0.5;
  }

  zoomOut(): void {
    this.getWebContents().zoomLevel -= 0.5;
  }

  zoomActualSize(): void {
    this.getWebContents().zoomLevel = 0;
  }

  logOut(): void {
    this.send("logout");
  }

  showKeyboardShortcuts(): void {
    this.send("show-keyboard-shortcuts");
  }

  openDevTools(): void {
    this.getWebContents().openDevTools();
  }

  back(): void {
    if (this.getWebContents().canGoBack()) {
      this.getWebContents().goBack();
      this.focus();
    }
  }

  canGoBackButton(): void {
    const $backButton = document.querySelector(
      "#actions-container #back-action",
    )!;
    $backButton.classList.toggle("disable", !this.getWebContents().navigationHistory.canGoBack());
  }

  forward(): void {
    if (this.getWebContents().navigationHistory.canGoForward()) {
      this.getWebContents().navigationHistory.goForward();
    }
  }

  reload(): void {
    this.hide();
    // Shows the loading indicator till the webview is reloaded
    this.$webviewsContainer.remove("loaded");
    this.loading = true;
    this.properties.switchLoading(true, this.properties.url);
    this.getWebContents().reload();
  }

  setUnsupportedMessage(unsupportedMessage: string | undefined) {
    this.$unsupported.hidden =
      unsupportedMessage === undefined || this.unsupportedDismissed;
    this.$unsupportedMessage.textContent = unsupportedMessage ?? "";
  }

  send<Channel extends keyof RendererMessage>(
    channel: Channel,
    ...arguments_: Parameters<RendererMessage[Channel]>
  ): void {
    ipcRenderer.send("forward-to", this.webContentsId, channel, ...arguments_);
  }

  private registerListeners(): void {
    const webContents = this.getWebContents();

    if (shouldSilentWebview) {
      webContents.setAudioMuted(true);
    }

    webContents.on("page-title-updated", (_event, title) => {
      this.badgeCount = this.getBadgeCount(title);
      this.properties.onTitleChange();
    });

    this.$webview.addEventListener("did-navigate-in-page", () => {
      this.canGoBackButton();
    });

    this.$webview.addEventListener("did-navigate", () => {
      this.canGoBackButton();
    });

    webContents.on("page-favicon-updated", (_event, favicons) => {
      // This returns a string of favicons URL. If there is a PM counts in unread messages then the URL would be like
      // https://chat.zulip.org/static/images/favicon/favicon-pms.png
      if (
        favicons[0].indexOf("favicon-pms") > 0 &&
        process.platform === "darwin"
      ) {
        // This api is only supported on macOS
        app.dock.setBadge("●");
        // Bounce the dock
        if (ConfigUtil.getConfigItem("dockBouncing", true)) {
          app.dock.bounce();
        }
      }
    });

    webContents.addListener("context-menu", (event, menuParameters) => {
      contextMenu(webContents, event, menuParameters);
    });

    this.$webview.addEventListener("dom-ready", () => {
      this.loading = false;
      this.properties.switchLoading(false, this.properties.url);
      this.show();
      this.getWebContents().executeJavaScript(`
          // Глобальный обработчик ошибок
          window.onerror = function(message, source, lineno, colno, error) {
              console.error('WebView: Ошибка:', message, 'в', source, 'строка', lineno, 'столбец', colno, 'error:', error);
          };
  
          // Обработчик необработанных промисов
          window.addEventListener('unhandledrejection', (event) => {
              console.error('WebView: Необработанный промис:', event.reason);
          });
  
          // Отладка окружения
          console.log('WebView: electron_bridge доступен:', !!window.electron_bridge);
          console.log('WebView: ipcRenderer доступен:', !!window.ipcRenderer);
          console.log('WebView: JitsiMeetJS доступен:', !!window.JitsiMeetJS);
          console.log('WebView: User-Agent:', navigator.userAgent);
  
          // Установка индикаторов Electron
          window.isElectron = true;
          window.electron = { version: '32.3.0' };
          console.log('WebView: Установлен isElectron:', window.isElectron);
          console.log('WebView: Установлен electron:', window.electron);
  
          // Имитация JitsiMeetScreenObtainer
          window.JitsiMeetScreenObtainer = {
              openDesktopPicker: async (options, onSuccess, onFailure) => {
                  console.log('WebView: JitsiMeetScreenObtainer.openDesktopPicker called with options:', options);
                  try {
                      const sources = await window.ipcRenderer.invoke('get-desktop-sources');
                      console.log('WebView: Источники от desktopCapturer:', sources);
                      if (sources && sources.length > 0) {
                          onSuccess(sources[0].id, 'screen', false);
                      } else {
                          onFailure(new Error('No sources selected'));
                      }
                  } catch (error) {
                      console.error('WebView: Ошибка в openDesktopPicker:', error);
                      onFailure(error);
                  }
              }
          };
          console.log('WebView: JitsiMeetScreenObtainer установлен:', !!window.JitsiMeetScreenObtainer);
  
          // Перехват Jitsi API
          (function() {
              // Перехват getDisplayMedia
              const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
              navigator.mediaDevices.getDisplayMedia = async function(constraints) {
                  console.log('WebView: getDisplayMedia called with constraints:', JSON.stringify(constraints));
                  try {
                      const sources = await window.ipcRenderer.invoke('get-desktop-sources');
                      console.log('WebView: Источники от desktopCapturer:', sources);
                      return navigator.mediaDevices.getUserMedia({
                          video: {
                              mandatory: {
                                  chromeMediaSource: 'desktop',
                                  chromeMediaSourceId: sources[0].id,
                              },
                          },
                      });
                  } catch (error) {
                      console.error('WebView: Ошибка в getDisplayMedia:', error);
                      throw error;
                  }
              };
  
              // Перехват JitsiMeetJS
              Object.defineProperty(window, 'JitsiMeetJS', {
                  get() {
                      console.log('WebView: JitsiMeetJS accessed');
                      return this._jitsiMeetJS;
                  },
                  set(value) {
                      console.log('WebView: JitsiMeetJS initialized');
                      this._jitsiMeetJS = value;
  
                      // Перехват browser.isElectron
                      value.browser = value.browser || {};
                      const originalIsElectron = value.browser.isElectron;
                      value.browser.isElectron = function() {
                          console.log('WebView: browser.isElectron called, returning true');
                          return true;
                      };
  
                      // Перехват _createObtainStreamMethod
                      if (value.desktopSharing) {
                          const originalCreateObtainStreamMethod = value.desktopSharing._createObtainStreamMethod;
                          value.desktopSharing._createObtainStreamMethod = function() {
                              console.log('WebView: _createObtainStreamMethod called, forcing obtainScreenOnElectron');
                              return this.obtainScreenOnElectron;
                          };
                          console.log('WebView: _createObtainStreamMethod перехвачен');
                      }
  
                      // Перехват createLocalTracks
                      const originalCreateLocalTracks = value.createLocalTracks;
                      value.createLocalTracks = async function(options) {
                          console.log('WebView: Jitsi createLocalTracks called with options:', JSON.stringify(options));
                          if (options.devices && options.devices.includes('desktop')) {
                              console.log('WebView: Jitsi пытается запустить демонстрацию экрана');
                              try {
                                  const sources = await window.ipcRenderer.invoke('get-desktop-sources');
                                  console.log('WebView: Источники от desktopCapturer для Jitsi:', sources);
                                  return [{
                                      deviceId: sources[0].id,
                                      kind: 'video',
                                      label: sources[0].name,
                                      getSettings: () => ({ deviceId: sources[0].id }),
                                      getConstraints: () => ({
                                          mandatory: {
                                              chromeMediaSource: 'desktop',
                                              chromeMediaSourceId: sources[0].id,
                                          },
                                      }),
                                  }];
                              } catch (error) {
                                  console.error('WebView: Ошибка в createLocalTracks:', error);
                                  throw error;
                              }
                          }
                          return originalCreateLocalTracks.apply(this, arguments);
                      };
                  }
              });
          })();
  
          // Отладка создания iframe
          const observer = new MutationObserver((mutations) => {
              mutations.forEach(mutation => {
                  mutation.addedNodes.forEach(node => {
                      if (node.nodeName === 'IFRAME') {
                          console.log('WebView: Обнаружен iframe:', node.src);
                      }
                  });
              });
          });
          observer.observe(document.body, { childList: true, subtree: true });
      `);
      // Открыть DevTools для WebView
      this.getWebContents().openDevTools();
    });

    webContents.on("did-fail-load", (_event, _errorCode, errorDescription) => {
      const hasConnectivityError =
        SystemUtil.connectivityError.includes(errorDescription);
      if (hasConnectivityError) {
        console.error("error", errorDescription);
        if (!this.properties.url.includes("network.html")) {
          this.properties.onNetworkError(this.properties.index);
        }
      }
    });

    this.$webview.addEventListener("did-start-loading", () => {
      this.properties.switchLoading(true, this.properties.url);
    });

    this.$webview.addEventListener("did-stop-loading", () => {
      this.properties.switchLoading(false, this.properties.url);
    });

    this.$unsupportedDismiss.addEventListener("click", () => {
      this.unsupportedDismissed = true;
      this.$unsupported.hidden = true;
    });

    webContents.on("zoom-changed", (event, zoomDirection) => {
      if (zoomDirection === "in") this.zoomIn();
      else if (zoomDirection === "out") this.zoomOut();
    });
  }

  private getBadgeCount(title: string): number {
    const messageCountInTitle = /^\((\d+)\)/.exec(title);
    return messageCountInTitle ? Number(messageCountInTitle[1]) : 0;
  }

  private show(): void {
    // Do not show WebView if another tab was selected and this tab should be in background.
    if (!this.properties.isActive()) {
      return;
    }

    // To show or hide the loading indicator in the active tab
    this.$webviewsContainer.toggle("loaded", !this.loading);

    this.$pane.classList.add("active");
    this.focus();
    this.properties.onTitleChange();
    // Injecting preload css in webview to override some css rules
    (async () => this.getWebContents().insertCSS(preloadCss))();

    // Get customCSS again from config util to avoid warning user again
    const customCss = ConfigUtil.getConfigItem("customCSS", null);
    this.customCss = customCss;
    if (customCss) {
      if (!fs.existsSync(customCss)) {
        this.customCss = null;
        ConfigUtil.setConfigItem("customCSS", null);

        const errorMessage = t.__("The custom CSS previously set is deleted.");
        dialog.showErrorBox(t.__("Custom CSS file deleted"), errorMessage);
        return;
      }

      (async () =>
        this.getWebContents().insertCSS(fs.readFileSync(customCss, "utf8")))();
    }
  }
}