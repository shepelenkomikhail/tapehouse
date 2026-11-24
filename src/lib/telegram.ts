/** Minimal typings for the parts of Telegram.WebApp that Tapehouse uses. */

type Callback<T> = (error: string | null, result?: T) => void;

export interface TelegramCloudStorage {
  setItem(key: string, value: string, callback?: Callback<boolean>): void;
  getItem(key: string, callback: Callback<string>): void;
  getItems(keys: string[], callback: Callback<Record<string, string>>): void;
  removeItems(keys: string[], callback?: Callback<boolean>): void;
  getKeys(callback: Callback<string[]>): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: { id: number; first_name?: string; username?: string };
    start_param?: string;
    chat_type?: string;
  };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  isVersionAtLeast(version: string): boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  openTelegramLink(url: string): void;
  openLink?(url: string): void;
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
  CloudStorage: TelegramCloudStorage;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** Returns the WebApp object only when we're actually running inside Telegram. */
export function getWebApp(): TelegramWebApp | undefined {
  const webApp = window.Telegram?.WebApp;
  return webApp?.initData ? webApp : undefined;
}

export function initTelegram() {
  const webApp = getWebApp();
  if (!webApp) {
    return;
  }
  webApp.ready();
  webApp.expand();
  if (webApp.isVersionAtLeast("7.7")) {
    webApp.disableVerticalSwipes?.(); // otherwise dragging tracks down can close the app
  }
}

export function hasCloudStorage() {
  return Boolean(getWebApp()?.isVersionAtLeast("6.9"));
}

export function getStartParam() {
  return (
    getWebApp()?.initDataUnsafe.start_param ??
    new URLSearchParams(window.location.search).get("tgWebAppStartParam") ??
    new URLSearchParams(window.location.search).get("startapp") ??
    undefined
  );
}

export const haptic = {
  tap: () => getWebApp()?.HapticFeedback?.impactOccurred("light"),
  select: () => getWebApp()?.HapticFeedback?.selectionChanged(),
  success: () => getWebApp()?.HapticFeedback?.notificationOccurred("success"),
  error: () => getWebApp()?.HapticFeedback?.notificationOccurred("error"),
};

export function confirmAction(message: string): Promise<boolean> {
  const webApp = getWebApp();
  if (webApp?.showConfirm && webApp.isVersionAtLeast("6.2")) {
    return new Promise((resolve) => webApp.showConfirm!(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/** Opens a web page outside the Mini App (Telegram's in-app browser when available). */
export function openExternal(url: string) {
  const webApp = getWebApp();
  if (webApp?.openLink) {
    webApp.openLink(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function openBotChat(botUsername?: string) {
  if (!botUsername) {
    return;
  }
  const url = `https://t.me/${botUsername}`;
  const webApp = getWebApp();
  if (webApp) {
    webApp.openTelegramLink(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
