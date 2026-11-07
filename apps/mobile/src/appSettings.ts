import * as SecureStore from "expo-secure-store";
import type { ThemePreference } from "./theme";

const KEY = "invx.mobile.appSettings";

export type MobileAppSettings = {
  /**
   * SAF directory URI from the system folder picker (content://…).
   * Empty = fall back to app Documents (not user-visible).
   */
  incomingFilesUri: string;
  /** Friendly label for the picked folder (optional). */
  incomingFilesLabel: string;
  /** Allow PC to run Termux commands on this phone. Default false. */
  allowRemoteTermux: boolean;
  /** Auto-push clipboard changes while foreground or Sync Keyboard IME. */
  autoClipboardSync: boolean;
  /** Include images in auto clipboard sync. */
  autoClipboardImages: boolean;
  /** Appearance preference. Default system. */
  theme: ThemePreference;
};

const defaults: MobileAppSettings = {
  incomingFilesUri: "",
  incomingFilesLabel: "",
  allowRemoteTermux: false,
  autoClipboardSync: false,
  autoClipboardImages: true,
  theme: "system",
};

function parseTheme(value: unknown): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return defaults.theme;
}

export async function loadAppSettings(): Promise<MobileAppSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<MobileAppSettings> & {
      /** @deprecated relative Documents path from earlier builds */
      incomingFilesDir?: string;
    };
    return {
      incomingFilesUri:
        typeof parsed.incomingFilesUri === "string"
          ? parsed.incomingFilesUri
          : defaults.incomingFilesUri,
      incomingFilesLabel:
        typeof parsed.incomingFilesLabel === "string"
          ? parsed.incomingFilesLabel
          : defaults.incomingFilesLabel,
      allowRemoteTermux:
        typeof parsed.allowRemoteTermux === "boolean"
          ? parsed.allowRemoteTermux
          : defaults.allowRemoteTermux,
      autoClipboardSync:
        typeof parsed.autoClipboardSync === "boolean"
          ? parsed.autoClipboardSync
          : defaults.autoClipboardSync,
      autoClipboardImages:
        typeof parsed.autoClipboardImages === "boolean"
          ? parsed.autoClipboardImages
          : defaults.autoClipboardImages,
      theme: parseTheme(parsed.theme),
    };
  } catch {
    return { ...defaults };
  }
}

export async function saveAppSettings(
  patch: Partial<MobileAppSettings>,
): Promise<MobileAppSettings> {
  const current = await loadAppSettings();
  const next: MobileAppSettings = {
    incomingFilesUri:
      typeof patch.incomingFilesUri === "string"
        ? patch.incomingFilesUri.trim()
        : current.incomingFilesUri,
    incomingFilesLabel:
      typeof patch.incomingFilesLabel === "string"
        ? patch.incomingFilesLabel.trim()
        : current.incomingFilesLabel,
    allowRemoteTermux:
      typeof patch.allowRemoteTermux === "boolean"
        ? patch.allowRemoteTermux
        : current.allowRemoteTermux,
    autoClipboardSync:
      typeof patch.autoClipboardSync === "boolean"
        ? patch.autoClipboardSync
        : current.autoClipboardSync,
    autoClipboardImages:
      typeof patch.autoClipboardImages === "boolean"
        ? patch.autoClipboardImages
        : current.autoClipboardImages,
    theme: patch.theme !== undefined ? parseTheme(patch.theme) : current.theme,
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next;
}
