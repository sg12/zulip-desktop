import { EventEmitter } from "node:events";
import { ipcRenderer } from "./typed-ipc-renderer.js";
import {
  type ClipboardDecrypter,
  ClipboardDecrypterImplementation,
} from "./clipboard-decrypter.js";
import { type NotificationData, newNotification } from "./notification/index.js";
import { WalkieTalkieStatus } from "../../common/typed-ipc.js";

type ListenerType = (...arguments_: any[]) => void;

export type ElectronBridge = {
  send_event: (eventName: string | symbol, ...arguments_: unknown[]) => boolean;
  on_event: (eventName: string, listener: ListenerType) => void;
  new_notification: (
    title: string,
    options: NotificationOptions,
    dispatch: (type: string, eventInit: EventInit) => boolean,
  ) => NotificationData;
  get_idle_on_system: () => boolean;
  get_last_active_on_system: () => number;
  get_send_notification_reply_message_supported: () => boolean;
  set_send_notification_reply_message_supported: (value: boolean) => void;
  decrypt_clipboard: (version: number) => ClipboardDecrypter;
};

let notificationReplySupported = false;
let idle = false;
let lastActive = Date.now();

export const bridgeEvents = new EventEmitter();

const electron_bridge: ElectronBridge = {
  send_event: (eventName: string | symbol, ...arguments_: unknown[]): boolean => {
    const name = String(eventName)
    ipcRenderer.send("preload-log", `Bridge: Отправлено событие: ${name} ${JSON.stringify(arguments_)}`);
    // Перенаправляем walkie-talkie-status в основной процесс
    if (String(eventName) === "walkie-talkie-status") {
      // Проверяем, что аргумент соответствует WalkieTalkieStatus
      const [status] = arguments_;
      if (typeof status !== "object" || status === null || !("enabled" in status) || !("key" in status)) {
        ipcRenderer.send("preload-log", `Bridge: Некорректный формат walkie-talkie-status: ${JSON.stringify(status)}`);
        return false;
      }
      ipcRenderer.send("walkie-talkie-status", status as WalkieTalkieStatus);
      return true;
    }
    return bridgeEvents.emit(eventName, ...arguments_);
  },

  on_event(eventName: string, listener: ListenerType): void {
    ipcRenderer.send("preload-log", `🔔 Bridge: Сайт слушает событие: ${eventName}`);
    bridgeEvents.on(eventName, listener);
  },
  
  // Alias для совместимости
  emit_event: (eventName: string | symbol, ...arguments_: unknown[]): boolean => {
    return bridgeEvents.emit(eventName, ...arguments_);
  },

  new_notification: (
    title: string,
    options: NotificationOptions,
    dispatch: (type: string, eventInit: EventInit) => boolean,
  ): NotificationData => newNotification(title, options, dispatch),

  get_idle_on_system: (): boolean => idle,

  get_last_active_on_system: (): number => lastActive,

  get_send_notification_reply_message_supported: (): boolean =>
    notificationReplySupported,

  set_send_notification_reply_message_supported(value: boolean): void {
    notificationReplySupported = value;
  },

  decrypt_clipboard: (version: number): ClipboardDecrypter =>
    new ClipboardDecrypterImplementation(version),
};

bridgeEvents.on("total_unread_count", (unreadCount: unknown) => {
  if (typeof unreadCount !== "number") {
    throw new TypeError("Expected number for unreadCount");
  }
  ipcRenderer.send("unread-count", unreadCount);
});

bridgeEvents.on("realm_name", (realmName: unknown) => {
  if (typeof realmName !== "string") {
    throw new TypeError("Expected string for realmName");
  }
  const serverUrl = location.origin;
  ipcRenderer.send("realm-name-changed", serverUrl, realmName);
});

bridgeEvents.on("realm_icon_url", (iconUrl: unknown) => {
  if (typeof iconUrl !== "string") {
    throw new TypeError("Expected string for iconUrl");
  }
  const serverUrl = location.origin;
  ipcRenderer.send(
    "realm-icon-changed",
    serverUrl,
    iconUrl.includes("http") ? iconUrl : `${serverUrl}${iconUrl}`,
  );
});

ipcRenderer.on("set-active", () => {
  idle = false;
  lastActive = Date.now();
});

ipcRenderer.on("set-idle", () => {
  idle = true;
});

ipcRenderer.on("trigger-open-desktop-picker", () => {
  ipcRenderer.send("preload-log", "✅ Bridge: Получена команда trigger-open-desktop-picker");
  electron_bridge.send_event("open-desktop-picker");
});

export default electron_bridge;