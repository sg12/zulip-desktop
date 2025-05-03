import { clipboard } from "electron/common";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import { Menu, app, desktopCapturer, dialog, session } from "@electron/remote";
import * as remote from "@electron/remote";
import * as Sentry from "@sentry/electron/renderer";

import type { Config } from "../../common/config-util.js";
import * as ConfigUtil from "../../common/config-util.js";
import * as DNDUtil from "../../common/dnd-util.js";
import type { DndSettings } from "../../common/dnd-util.js";
import * as EnterpriseUtil from "../../common/enterprise-util.js";
import { html } from "../../common/html.js";
import * as LinkUtil from "../../common/link-util.js";
import Logger from "../../common/logger-util.js";
import * as Messages from "../../common/messages.js";
import { bundlePath, bundleUrl } from "../../common/paths.js";
import * as t from "../../common/translation-util.js";
import type {
  NavigationItem,
  ServerConfig,
  TabData,
  TabPage,
} from "../../common/types.js";
import defaultIcon from "../img/icon.png";

import FunctionalTab from "./components/functional-tab.js";
import ServerTab from "./components/server-tab.js";
import WebView from "./components/webview.js";
import { AboutView } from "./pages/about.js";
import { PreferenceView } from "./pages/preference/preference.js";
import { initializeTray } from "./tray.js";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import * as DomainUtil from "./utils/domain-util.js";
import ReconnectUtil from "./utils/reconnect-util.js";

Sentry.init({});

type WebviewListener =
  | "webview-reload"
  | "back"
  | "focus"
  | "forward"
  | "zoomIn"
  | "zoomOut"
  | "zoomActualSize"
  | "log-out"
  | "show-keyboard-shortcuts"
  | "tab-devtools";

const logger = new Logger({
  file: "errors.log",
});

type ServerOrFunctionalTab = ServerTab | FunctionalTab;

const rootWebContents = remote.getCurrentWebContents();

const dingSound = new Audio(
  new URL("resources/sounds/ding.ogg", bundleUrl).href,
);

export class ServerManagerView {
  $tabsContainer: Element;
  $reloadButton: HTMLButtonElement;
  $loadingIndicator: HTMLButtonElement;
  $settingsButton: HTMLButtonElement;
  $webviewsContainer: Element;
  $backButton: HTMLButtonElement;
  $dndButton: HTMLButtonElement;
  $addServerTooltip: HTMLElement;
  $reloadTooltip: HTMLElement;
  $loadingTooltip: HTMLElement;
  $settingsTooltip: HTMLElement;
  $serverIconTooltip: HTMLCollectionOf<HTMLElement>;
  $backTooltip: HTMLElement;
  $dndTooltip: HTMLElement;
  $sidebar: Element;
  $fullscreenPopup: Element;
  $fullscreenEscapeKey: string;
  loading: Set<string>;
  activeTabIndex: number;
  tabs: ServerOrFunctionalTab[];
  functionalTabs: Map<TabPage, number>;
  tabIndex: number;
  presetOrgs: string[];
  preferenceView?: PreferenceView;

  // Элементы для кнопки обновления
  $updateButton: HTMLButtonElement;
  $updateTooltip: HTMLElement;

  constructor() {
    this.$tabsContainer = document.querySelector("#tabs-container")!;

    const $actionsContainer = document.querySelector("#actions-container")!;
    this.$reloadButton = $actionsContainer.querySelector("#reload-action")!;
    this.$loadingIndicator = $actionsContainer.querySelector("#loading-action")!;
    this.$settingsButton = $actionsContainer.querySelector("#settings-action")!;
    this.$webviewsContainer = document.querySelector("#webviews-container")!;
    this.$backButton = $actionsContainer.querySelector("#back-action")!;
    this.$dndButton = $actionsContainer.querySelector("#dnd-action")!;

    // Инициализация кнопки обновления
    this.$updateButton = $actionsContainer.querySelector("#update-action")!;
    this.$updateTooltip = $actionsContainer.querySelector("#update-tooltip")!;

    this.$addServerTooltip = document.querySelector("#add-server-tooltip")!;
    this.$reloadTooltip = $actionsContainer.querySelector("#reload-tooltip")!;
    this.$loadingTooltip = $actionsContainer.querySelector("#loading-tooltip")!;
    this.$settingsTooltip = $actionsContainer.querySelector("#setting-tooltip")!;

    this.$serverIconTooltip = document.getElementsByClassName(
      "server-tooltip",
    ) as HTMLCollectionOf<HTMLElement>;
    this.$backTooltip = $actionsContainer.querySelector("#back-tooltip")!;
    this.$dndTooltip = $actionsContainer.querySelector("#dnd-tooltip")!;

    this.$sidebar = document.querySelector("#sidebar")!;

    this.$fullscreenPopup = document.querySelector("#fullscreen-popup")!;
    this.$fullscreenEscapeKey = process.platform === "darwin" ? "^⌘F" : "F11";
    this.$fullscreenPopup.textContent = `Press ${this.$fullscreenEscapeKey} to exit full screen`;

    this.loading = new Set();
    this.activeTabIndex = -1;
    this.tabs = [];
    this.presetOrgs = [];
    this.functionalTabs = new Map();
    this.tabIndex = 0;
    logger.info("Тут Ооочень нужен лог");
  }

  async init(): Promise<void> {
    // Показываем индикатор загрузки
    const loadingIndicator = document.getElementById("loading-indicator");
    if (loadingIndicator) {
      loadingIndicator.style.display = "flex";
    }
  
    // Выполняем асинхронные операции параллельно
    await Promise.all([
      (async () => {
        initializeTray(this);
      })(),
      (async () => {
        await this.loadProxy();
      })(),
      (async () => {
        this.initDefaultSettings();
        this.initSidebar();
        this.removeUaFromDisk();
      })(),
    ]);
  
    await this.initTabs();
    this.initActions();
    this.registerIpcs();
  
    // Скрываем индикатор загрузки
    if (loadingIndicator) {
      loadingIndicator.style.display = "none";
    }
  }

  async loadProxy(): Promise<void> {
    const proxyEnabledOld = ConfigUtil.isConfigItemExists("useProxy");
    if (proxyEnabledOld) {
      const proxyEnableOldState = ConfigUtil.getConfigItem("useProxy", false);
      if (proxyEnableOldState) {
        ConfigUtil.setConfigItem("useManualProxy", true);
      }
      ConfigUtil.removeConfigItem("useProxy");
    }

    await session.fromPartition("persist:webviewsession").setProxy(
      ConfigUtil.getConfigItem("useSystemProxy", false)
        ? { mode: "system" }
        : ConfigUtil.getConfigItem("useManualProxy", false)
        ? {
            pacScript: ConfigUtil.getConfigItem("proxyPAC", ""),
            proxyRules: ConfigUtil.getConfigItem("proxyRules", ""),
            proxyBypassRules: ConfigUtil.getConfigItem("proxyBypass", ""),
          }
        : { mode: "direct" }
    );
  }

  initDefaultSettings(): void {
    const settingOptions: Partial<Config> = {
      autoHideMenubar: false,
      trayIcon: true,
      useManualProxy: false,
      useSystemProxy: false,
      showSidebar: true,
      badgeOption: true,
      startAtLogin: false,
      startMinimized: false,
      enableSpellchecker: true,
      showNotification: true,
      autoUpdate: true,
      betaUpdate: false,
      errorReporting: true,
      customCSS: false,
      silent: false,
      lastActiveTab: 0,
      dnd: false,
      dndPreviousSettings: {
        showNotification: true,
        silent: false,
      },
      downloadsPath: `${app.getPath("downloads")}`,
      quitOnClose: false,
      promptDownload: false,
    };

    if (process.platform === "win32") {
      settingOptions.flashTaskbarOnMessage = true;
      settingOptions.dndPreviousSettings!.flashTaskbarOnMessage = true;
    }

    if (process.platform === "darwin") {
      settingOptions.dockBouncing = true;
    }

    if (process.platform !== "darwin") {
      settingOptions.autoHideMenubar = false;
      settingOptions.spellcheckerLanguages = ["en-US"];
    }

    for (const [setting, value] of Object.entries(settingOptions) as Array<
      { [Key in keyof Config]: [Key, Config[Key]] }[keyof Config]
    >) {
      if (EnterpriseUtil.configItemExists(setting)) {
        ConfigUtil.setConfigItem(
          setting,
          EnterpriseUtil.getConfigItem(setting, value),
          true
        );
      } else if (!ConfigUtil.isConfigItemExists(setting)) {
        ConfigUtil.setConfigItem(setting, value);
      }
    }
  }

  initSidebar(): void {
    const showSidebar = ConfigUtil.getConfigItem("showSidebar", true);
    this.toggleSidebar(showSidebar);
  }

  removeUaFromDisk(): void {
    ConfigUtil.removeConfigItem("userAgent");
  }

  async queueDomain(domain: string): Promise<boolean> {
    try {
      const serverConfig = await DomainUtil.checkDomain(domain);
      await DomainUtil.addDomain(serverConfig);
      return true;
    } catch (error: unknown) {
      logger.error(error);
      logger.error(
        `Could not add ${domain}. Please contact your system administrator.`
      );
      return false;
    }
  }

  async initPresetOrgs(): Promise<void> {
    const preAddedDomains = DomainUtil.getDomains();
    this.presetOrgs = EnterpriseUtil.getConfigItem("presetOrganizations", []);
    const domainPromises = [];
    for (const url of this.presetOrgs) {
      if (DomainUtil.duplicateDomain(url)) {
        continue;
      }
      domainPromises.push(this.queueDomain(url));
    }

    const domainsAdded = await Promise.all(domainPromises);
    if (domainsAdded.includes(true)) {
      if (preAddedDomains.length > 0) {
        const { response } = await dialog.showMessageBox({
          type: "question",
          buttons: [t.__("Yes"), t.__("Later")],
          defaultId: 0,
          message: t.__("New servers added. Reload app now?"),
        });
        if (response === 0) {
          ipcRenderer.send("reload-full-app");
        }
      } else {
        ipcRenderer.send("reload-full-app");
      }
    } else if (domainsAdded.length > 0) {
      const failedDomains: string[] = [];
      for (const org of this.presetOrgs) {
        if (DomainUtil.duplicateDomain(org)) {
          continue;
        }
        failedDomains.push(org);
      }

      const { title, content } = Messages.enterpriseOrgError(
        domainsAdded.length,
        failedDomains
      );
      dialog.showErrorBox(title, content);
      if (DomainUtil.getDomains().length === 0) {
      }
    }
  }
//localhost:9991
//https://joinrm-svz.ru/
//https://connectrm-svz.ru/
  async initTabs(): Promise<void> {
    const server = {
      url: "https://joinrm-svz.ru/",
      alias: "Цифровые технологии РМ",
      icon: "https://disk.yandex.ru/i/m2aj56OOhsJfyw",
    } as ServerConfig;
  
    DomainUtil.removeDomains();
    const tab = this.initServer(server, 0);
    DomainUtil.addDomain(server);
  
    // Устанавливаем метку сразу
    tab.setLabel(server.alias);
  
    // Откладываем загрузку иконки
    setTimeout(async () => {
      try {
        const iconUrl = await DomainUtil.saveServerIcon(server.icon);
        tab.setIcon(DomainUtil.iconAsUrl(iconUrl));
      } catch (error) {
        console.log("Error loading server icon:", error);
        tab.setIcon(DomainUtil.iconAsUrl("https://connectrm-svz.ru//user_avatars/2/realm/night_logo.png?version=2")); // Используем запасную иконку
      }
    }, 0);
  
    await this.activateTab(0);
  }

  initServer(server: ServerConfig, index: number): ServerTab {
    console.log("$webviewsContainer:", this.$webviewsContainer);
    console.log("server.url:", server.url);
    console.log("preload:", url.pathToFileURL(path.join(bundlePath, "preload.js")).href);

    const tabIndex = this.getTabIndex();

    const webView = WebView.create({
      $root: this.$webviewsContainer,
      rootWebContents,
      index,
      tabIndex,
      url: server.url,
      role: "server",
      hasPermission: (origin: string, permission: string) => true,
      isActive: () => index === this.activeTabIndex,
      switchLoading: async (loading: boolean, url: string) => {
        if (loading) {
          this.loading.add(url);
        } else {
          this.loading.delete(url);
        }

        const tab = this.tabs[this.activeTabIndex];
        this.showLoading(
          tab instanceof ServerTab &&
          this.loading.has((await tab.webview).properties.url)
        );
      },
      onNetworkError: async (index: number) => {
        await this.openNetworkTroubleshooting(index);
      },
      onTitleChange: this.updateBadge.bind(this),
      preload: url.pathToFileURL(path.join(bundlePath, "preload.js")).href,
      unsupportedMessage: DomainUtil.getUnsupportedMessage(server),
    });

    const tab = new ServerTab({
      role: "server",
      icon: DomainUtil.iconAsUrl(server.icon),
      label: server.alias,
      $root: this.$tabsContainer,
      onClick: this.activateLastTab.bind(this, index),
      index,
      tabIndex,
      onHover: this.onHover.bind(this, index),
      onHoverOut: this.onHoverOut.bind(this, index),
      webview: webView,
    });
    this.tabs.push(tab);
    this.loading.add(server.url);
    return tab;
  }

  initActions(): void {
    this.initDndButton();
    this.initServerActions();
    this.initLeftSidebarEvents();
  }

  initServerActions(): void {
    const $serverImgs: NodeListOf<HTMLImageElement> =
      document.querySelectorAll(".server-icons");
    for (const [index, $serverImg] of $serverImgs.entries()) {
      this.addContextMenu($serverImg, index);
      if ($serverImg.src === defaultIcon) {
        this.displayInitialCharLogo($serverImg, index);
      }

      $serverImg.addEventListener("error", () => {
        this.displayInitialCharLogo($serverImg, index);
      });
    }
  }

  initLeftSidebarEvents(): void {
    this.$dndButton.addEventListener("click", () => {
      const dndUtil = DNDUtil.toggle();
      ipcRenderer.send(
        "forward-message",
        "toggle-dnd",
        dndUtil.dnd,
        dndUtil.newSettings
      );
    });
    this.$reloadButton.addEventListener("click", async () => {
      const tab = this.tabs[this.activeTabIndex];
      if (tab instanceof ServerTab) (await tab.webview).reload();
    });
    this.$settingsButton.addEventListener("click", async () => {
      await this.openSettings("General");
    });
    this.$backButton.addEventListener("click", async () => {
      const tab = this.tabs[this.activeTabIndex];
      if (tab instanceof ServerTab) (await tab.webview).back();
    });

    // Добавляем обработчик для кнопки обновления
    this.$updateButton.addEventListener("click", () => {
      ipcRenderer.send("restart_app");
    });

    this.sidebarHoverEvent(this.$loadingIndicator, this.$loadingTooltip);
    this.sidebarHoverEvent(this.$settingsButton, this.$settingsTooltip);
    this.sidebarHoverEvent(this.$reloadButton, this.$reloadTooltip);
    this.sidebarHoverEvent(this.$backButton, this.$backTooltip);
    this.sidebarHoverEvent(this.$dndButton, this.$dndTooltip);
    this.sidebarHoverEvent(this.$updateButton, this.$updateTooltip);
  }

  initDndButton(): void {
    const dnd = ConfigUtil.getConfigItem("dnd", false);
    this.toggleDndButton(dnd);
  }

  getTabIndex(): number {
    const currentIndex = this.tabIndex;
    this.tabIndex++;
    return currentIndex;
  }

  async getCurrentActiveServer(): Promise<string> {
    const tab = this.tabs[this.activeTabIndex];
    return tab instanceof ServerTab ? (await tab.webview).properties.url : "";
  }

  displayInitialCharLogo($img: HTMLImageElement, index: number): void {
    const $altIcon = document.createElement("div");
    const $parent = $img.parentElement!;
    const $container = $parent.parentElement!;
    const webviewId = $container.dataset.tabId!;
    const $webview = document.querySelector(
      `webview[data-tab-id="${CSS.escape(webviewId)}"]`
    )!;
    const realmName = $webview.getAttribute("name");

    if (realmName === null) {
      $img.src = defaultIcon;
      return;
    }

    $altIcon.textContent = realmName.charAt(0) || "Z";
    $altIcon.classList.add("server-icon");
    $altIcon.classList.add("alt-icon");

    $img.remove();
    $parent.append($altIcon);

    this.addContextMenu($altIcon, index);
  }

  sidebarHoverEvent(
    SidebarButton: HTMLButtonElement,
    SidebarTooltip: HTMLElement,
    addServer = false
  ): void {
    SidebarButton.addEventListener("mouseover", () => {
      SidebarTooltip.removeAttribute("style");
      if (addServer) {
        const { top } = SidebarButton.getBoundingClientRect();
        SidebarTooltip.style.top = `${top}px`;
      }
    });
    SidebarButton.addEventListener("mouseout", () => {
      SidebarTooltip.style.display = "none";
    });
  }

  onHover(index: number): void {
    this.$serverIconTooltip[index].removeAttribute("style");
    const { top } =
      this.$serverIconTooltip[index].parentElement!.getBoundingClientRect();
    this.$serverIconTooltip[index].style.top = `${top}px`;
  }

  onHoverOut(index: number): void {
    this.$serverIconTooltip[index].style.display = "none";
  }

  async openFunctionalTab(tabProperties: {
    label: string;
    page: TabPage;
    materialIcon: string;
    makeView: () => Promise<Element>;
    destroyView: () => void;
  }): Promise<void> {
    if (this.functionalTabs.has(tabProperties.page)) {
      await this.activateTab(this.functionalTabs.get(tabProperties.page)!);
      return;
    }

    const index = this.tabs.length;
    this.functionalTabs.set(tabProperties.page, index);

    const tabIndex = this.getTabIndex();
    const $view = await tabProperties.makeView();
    this.$webviewsContainer.append($view);

    this.tabs.push(
      new FunctionalTab({
        role: "function",
        materialIcon: tabProperties.materialIcon,
        label: tabProperties.label,
        page: tabProperties.page,
        $root: this.$tabsContainer,
        index,
        tabIndex,
        onClick: this.activateTab.bind(this, index),
        onDestroy: async () => {
          await this.destroyFunctionalTab(tabProperties.page, index);
          tabProperties.destroyView();
        },
        $view,
      })
    );

    this.$webviewsContainer.classList.remove("loaded");
    await this.activateTab(this.functionalTabs.get(tabProperties.page)!);
  }

  async openSettings(navigationItem: NavigationItem = "General"): Promise<void> {
    await this.openFunctionalTab({
      page: "Settings",
      label: t.__("Settings"),
      materialIcon: "settings",
      makeView: async () => {
        this.preferenceView = await PreferenceView.create();
        this.preferenceView.$view.classList.add("functional-view");
        return this.preferenceView.$view;
      },
      destroyView: () => {
        this.preferenceView!.destroy();
        this.preferenceView = undefined;
      },
    });
    this.$settingsButton.classList.add("active");
    this.preferenceView!.handleNavigation(navigationItem);
  }

  async openAbout(): Promise<void> {
    let aboutView: AboutView;
    await this.openFunctionalTab({
      page: "About",
      label: t.__("About"),
      materialIcon: "sentiment_very_satisfied",
      async makeView() {
        aboutView = await AboutView.create();
        aboutView.$view.classList.add("functional-view");
        return aboutView.$view;
      },
      destroyView() {
        aboutView.destroy();
      },
    });
  }

  async openNetworkTroubleshooting(index: number): Promise<void> {
    const tab = this.tabs[index];
    if (!(tab instanceof ServerTab)) return;
    const webview = await tab.webview;
    const reconnectUtil = new ReconnectUtil(webview);
    reconnectUtil.pollInternetAndReload();
    await webview
      .getWebContents()
      .loadURL(new URL("app/renderer/network.html", bundleUrl).href);
  }

  async activateLastTab(index: number): Promise<void> {
    await this.activateTab(index);
    ipcRenderer.send("save-last-tab", index);
  }

  get tabsForIpc(): TabData[] {
    return this.tabs.map((tab) => ({
      role: tab.properties.role,
      page: tab.properties.page,
      label: tab.properties.label,
      index: tab.properties.index,
    }));
  }

  async activateTab(index: number, hideOldTab = true): Promise<void> {
    const tab = this.tabs[index];
    if (!tab) return;

    if (this.activeTabIndex !== -1) {
      if (this.activeTabIndex === index) return;
      if (hideOldTab) {
        if (
          this.tabs[this.activeTabIndex].properties.role === "function" &&
          this.tabs[this.activeTabIndex].properties.page === "Settings"
        ) {
          this.$settingsButton.classList.remove("active");
        }
        await this.tabs[this.activeTabIndex].deactivate();
      }
    }

    if (tab instanceof ServerTab) {
      try {
        (await tab.webview).canGoBackButton();
      } catch {}
    } else {
      document
        .querySelector("#actions-container #back-action")!
        .classList.add("disable");
    }

    this.activeTabIndex = index;
    await tab.activate();

    this.showLoading(
      tab instanceof ServerTab &&
      this.loading.has((await tab.webview).properties.url)
    );

    ipcRenderer.send("update-menu", {
      tabs: this.tabsForIpc,
      activeTabIndex: this.activeTabIndex,
      enableMenu: tab.properties.role === "server",
    });
  }

  showLoading(loading: boolean): void {
    this.$reloadButton.classList.toggle("hidden", loading);
    this.$loadingIndicator.classList.toggle("hidden", !loading);
  }

  async destroyFunctionalTab(page: TabPage, index: number): Promise<void> {
    const tab = this.tabs[index];
    if (tab instanceof ServerTab && (await tab.webview).loading) return;

    await tab.destroy();
    delete this.tabs[index];
    this.functionalTabs.delete(page);

    if (this.activeTabIndex === index) {
      await this.activateTab(0, false);
    }
  }

  destroyView(): void {
    this.$webviewsContainer.classList.remove("loaded");
    this.activeTabIndex = -1;
    this.tabs = [];
    this.functionalTabs.clear();
    this.$tabsContainer.textContent = "";
    this.$webviewsContainer.textContent = "";
  }

  async reloadView(): Promise<void> {
    const lastActiveTab = this.tabs[this.activeTabIndex].properties.index;
    ConfigUtil.setConfigItem("lastActiveTab", lastActiveTab);
    this.destroyView();
    await this.initTabs();
    this.initServerActions();
  }

  reloadCurrentView(): void {
    this.$reloadButton.click();
  }

  async updateBadge(): Promise<void> {
    let messageCountAll = 0;
    await Promise.all(
      this.tabs.map(async (tab) => {
        if (tab && tab instanceof ServerTab && tab.updateBadge) {
          const count = (await tab.webview).badgeCount;
          messageCountAll += count;
          tab.updateBadge(count);
        }
      })
    );
    ipcRenderer.send("update-badge", messageCountAll);
  }

  toggleSidebar(show: boolean): void {
    this.$sidebar.classList.toggle("sidebar-hide", !show);
  }

  toggleDndButton(alert: boolean): void {
    this.$dndTooltip.textContent =
      (alert ? "Disable" : "Enable") + " Do Not Disturb";
    this.$dndButton.querySelector("i")!.textContent = alert
      ? "notifications_off"
      : "notifications";
  }

  async isLoggedIn(tabIndex: number): Promise<boolean> {
    const tab = this.tabs[tabIndex];
    if (!(tab instanceof ServerTab)) return false;
    const webview = await tab.webview;
    const url = webview.getWebContents().getURL();
    return !(url.endsWith("/login/") || webview.loading);
  }

  addContextMenu($serverImg: HTMLElement, index: number): void {
    $serverImg.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      const template = [
        {
          label: t.__("Notification settings"),
          enabled: await this.isLoggedIn(index),
          click: async () => {
            await this.activateTab(index);
            const tab = this.tabs[index];
            if (tab instanceof ServerTab)
              (await tab.webview).showNotificationSettings();
          },
        },
        {
          label: t.__("Copy RM URL"),
          click() {
            clipboard.writeText(DomainUtil.getDomain(index).url);
          },
        },
      ];
      const contextMenu = Menu.buildFromTemplate(template);
      contextMenu.popup({ window: remote.getCurrentWindow() });
    });
  }

  registerIpcs(): void {
    const webviewListeners: Array<[WebviewListener, (webview: WebView) => void]> = [
      ["webview-reload", (webview) => { webview.reload(); }],
      ["back", (webview) => { webview.back(); }],
      ["focus", (webview) => { webview.focus(); }],
      ["forward", (webview) => { webview.forward(); }],
      ["zoomIn", (webview) => { webview.zoomIn(); }],
      ["zoomOut", (webview) => { webview.zoomOut(); }],
      ["zoomActualSize", (webview) => { webview.zoomActualSize(); }],
      ["log-out", (webview) => { webview.logOut(); }],
      ["show-keyboard-shortcuts", (webview) => { webview.showKeyboardShortcuts(); }],
      ["tab-devtools", (webview) => { webview.openDevTools(); }],
    ];
  
    for (const [channel, listener] of webviewListeners) {
      ipcRenderer.on(channel, async () => {
        const tab = this.tabs[this.activeTabIndex];
        if (tab instanceof ServerTab) {
          const activeWebview = await tab.webview;
          if (activeWebview) listener(activeWebview);
        }
      });
    }

    ipcRenderer.on("quit-app", () => {
      console.log("Renderer: Received quit-app event, forwarding to main process");
      ipcRenderer.send("quit-app");
    });

    ipcRenderer.on("permission-request", async (
      event,
      { webContentsId, origin, permission }: { webContentsId: number | null; origin: string; permission: string },
      permissionCallbackId: number,
    ) => {
      ipcRenderer.send("permission-callback", permissionCallbackId, true);
    });

    ipcRenderer.on("open-settings", async () => { await this.openSettings(); });
    ipcRenderer.on("open-about", this.openAbout.bind(this));
    ipcRenderer.on("reload-viewer", this.reloadView.bind(this));
    ipcRenderer.on("reload-current-viewer", this.reloadCurrentView.bind(this));
    ipcRenderer.on("hard-reload", () => { ipcRenderer.send("reload-full-app"); });
    ipcRenderer.on("switch-server-tab", async (event, index: number) => { await this.activateLastTab(index); });
    ipcRenderer.on("reload-proxy", async (event, showAlert: boolean) => {
      await this.loadProxy();
      if (showAlert) {
        await dialog.showMessageBox({ message: t.__("Proxy settings saved."), buttons: [t.__("OK")] });
        ipcRenderer.send("reload-full-app");
      }
    });
    ipcRenderer.on("toggle-sidebar", async (event, show: boolean) => { this.toggleSidebar(show); });
    ipcRenderer.on("toggle-silent", async (event, state: boolean) =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab) (await tab.webview).getWebContents().setAudioMuted(state);
      })),
    );
    ipcRenderer.on("toggle-autohide-menubar", async (event, autoHideMenubar: boolean, updateMenu: boolean) => {
      if (updateMenu) {
        ipcRenderer.send("update-menu", { tabs: this.tabsForIpc, activeTabIndex: this.activeTabIndex });
      }
    });
    ipcRenderer.on("toggle-dnd", async (event, state: boolean, newSettings: Partial<DndSettings>) => {
      this.toggleDndButton(state);
      ipcRenderer.send("forward-message", "toggle-silent", newSettings.silent ?? false);
    });
    ipcRenderer.on("update-realm-name", (event, serverURL: string, realmName: string) => {
      for (const [index, domain] of DomainUtil.getDomains().entries()) {
        if (domain.url === serverURL) {
          const tab = this.tabs[index];
          if (tab instanceof ServerTab) tab.setLabel(realmName);
          domain.alias = realmName;
          DomainUtil.updateDomain(index, domain);
          ipcRenderer.send("update-menu", { tabs: this.tabsForIpc, activeTabIndex: this.activeTabIndex });
        }
      }
    });
    ipcRenderer.on("update-realm-icon", async (event, serverURL: string, iconURL: string) => {
      await Promise.all(DomainUtil.getDomains().map(async (domain, index) => {
        if (domain.url === serverURL) {
          const localIconPath = await DomainUtil.saveServerIcon(iconURL);
          const tab = this.tabs[index];
          if (tab instanceof ServerTab) tab.setIcon(DomainUtil.iconAsUrl(localIconPath));
          domain.icon = localIconPath;
          DomainUtil.updateDomain(index, domain);
        }
      }));
    });
    ipcRenderer.on("enter-fullscreen", () => {
      this.$fullscreenPopup.classList.add("show");
      this.$fullscreenPopup.classList.remove("hidden");
    });
    ipcRenderer.on("leave-fullscreen", () => { this.$fullscreenPopup.classList.remove("show"); });
    ipcRenderer.on("focus-webview-with-id", async (event, webviewId: number) =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab && (await tab.webview).webContentsId === webviewId) {
          const concurrentTab: HTMLButtonElement = document.querySelector(
            `div[data-tab-id="${CSS.escape(`${tab.properties.tabIndex}`)}"]`,
          )!;
          concurrentTab.click();
        }
      })),
    );
    ipcRenderer.on("render-taskbar-icon", (event, messageCount: number) => {
      function createOverlayIcon(messageCount: number): HTMLCanvasElement {
        const canvas = document.createElement("canvas");
        canvas.height = 128;
        canvas.width = 128;
        canvas.style.letterSpacing = "-5px";
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#f42020";
        context.beginPath();
        context.ellipse(64, 64, 64, 64, 0, 0, 2 * Math.PI);
        context.fill();
        context.textAlign = "center";
        context.fillStyle = "white";
        if (messageCount > 99) {
          context.font = "65px Helvetica";
          context.fillText("99+", 64, 85);
        } else if (messageCount < 10) {
          context.font = "90px Helvetica";
          context.fillText(String(Math.min(99, messageCount)), 64, 96);
        } else {
          context.font = "85px Helvetica";
          context.fillText(String(Math.min(99, messageCount)), 64, 90);
        }
        return canvas;
      }
      ipcRenderer.send("update-taskbar-icon", createOverlayIcon(messageCount).toDataURL(), String(messageCount));
    });
    ipcRenderer.on("copy-rm-url", async () => { clipboard.writeText(await this.getCurrentActiveServer()); });
    ipcRenderer.on("set-active", async () =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab) (await tab.webview).send("set-active");
      })),
    );
    ipcRenderer.on("set-idle", async () =>
      Promise.all(this.tabs.map(async (tab) => {
        if (tab instanceof ServerTab) (await tab.webview).send("set-idle");
      })),
    );
    ipcRenderer.on("open-network-settings", async () => { await this.openSettings("Network"); });
    ipcRenderer.on("play-ding-sound", async () => { await dingSound.play(); });

    // Обработчики для автообновления
    ipcRenderer.on("update_available", (event, version: string) => {
      this.$updateTooltip.innerText = `Доступно: v${version}`;
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("update_progress", (event, percent: number) => {
      this.$updateTooltip.innerText = `Загрузка: ${~~percent}%`;
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("update_downloaded", () => {
      this.$updateTooltip.innerText = "Готово!";
      this.$updateButton.classList.remove("hidden");
    });

    ipcRenderer.on("update_error", (event, message: string) => {
      this.$updateTooltip.innerText = `Ошибка: ${message}`;
      this.$updateButton.classList.remove("hidden");
    });
  }
}

window.addEventListener("load", async () => {
  document.body.innerHTML = html`
    <div id="content">
      <div class="popup">
        <span class="popuptext hidden" id="fullscreen-popup"></span>
      </div>
      <div id="sidebar" class="toggle-sidebar">
        <div id="view-controls-container">
          <div id="tabs-container"></div>
        </div>
        <div id="actions-container">
        <!-- Добавляем кнопку для обновления приложения -->
          <div class="action-button hidden" id="update-action">
            <i class="material-icons md-48">system_update</i>
            <span id="update-tooltip" style="display: none">${t.__("Update Available")}</span>
          </div>
          <div class="action-button" id="dnd-action">
            <i class="material-icons md-48">notifications</i>
            <span id="dnd-tooltip" style="display: none">${t.__("Do Not Disturb")}</span>
          </div>
          <div class="action-button hidden" id="reload-action">
            <i class="material-icons md-48">refresh</i>
            <span id="reload-tooltip" style="display: none">${t.__("Reload")}</span>
          </div>
          <div class="action-button disable" id="loading-action">
            <i class="refresh material-icons md-48">loop</i>
            <span id="loading-tooltip" style="display: none">${t.__("Loading")}</span>
          </div>
          <div class="action-button disable" id="back-action">
            <i class="material-icons md-48">arrow_back</i>
            <span id="back-tooltip" style="display: none">${t.__("Go Back")}</span>
          </div>
          <div class="action-button" id="settings-action">
            <i class="material-icons md-48">settings</i>
            <span id="setting-tooltip" style="display: none">${t.__("Settings")}</span>
          </div>
        </div>
      </div>
      <div id="main-container">
        <div id="webviews-container"></div>
      </div>
    </div>
  `.html;

  const serverManagerView = new ServerManagerView();
  await serverManagerView.init();

  // const redButton = document.createElement("button");
  // redButton.id = "red-button";
  // redButton.textContent = "Click Me";
  // redButton.style.cssText = `
  //   position: absolute;
  //   top: 10px;
  //   left: 50%;
  //   transform: translateX(-50%);
  //   width: 200px;
  //   height: 100px;
  //   background-color: red;
  //   color: white;
  //   font-size: 24px;
  //   border: none;
  //   border-radius: 10px;
  //   cursor: pointer;
  //   z-index: 1000;
  // `;

  // document.body.appendChild(redButton);

  // redButton.addEventListener("click", async () => {
  //   console.log("RRRR-click");
  //   try {
  //     console.log('Запуск DesktopPicker для демонстрации экрана...');
  //     ipcRenderer.send('open-desktop-picker');
  //     console.log('DesktopPicker успешно вызван, ожидаем выбор пользователя...');
  
  //     // Listen for sources from the main process
  //     ipcRenderer.on('desktop-sources-response', (event, { sources, error }) => {
  //       if (error) {
  //         console.error('Ошибка получения источников:', error);
  //         return;
  //       }
  //       console.log('Renderer: Получены источники для демонстрации:', sources);
  //       // Pass sources to Jitsi or other logic
  //     });
  
  //     // Request sources directly via IPC
  //     const sources = await ipcRenderer.invoke('get-desktop-sources');
  //     console.log('Renderer: Прямой вызов источников:', sources);
  //   } catch (error) {
  //     console.error('Ошибка при вызове DesktopPicker:', error);
  //   }
  // });
});