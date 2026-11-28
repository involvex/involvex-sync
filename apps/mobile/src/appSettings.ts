import * as SecureStore from "expo-secure-store";
import type { ThemePreference } from "./theme";

const KEY = "invx.mobile.appSettings";

export type ClipboardHistoryMax = 10 | 25 | 50;

const HISTORY_MAX_PRESETS: readonly ClipboardHistoryMax[] = [10, 25, 50];

export function parseClipboardHistoryMax(value: unknown): ClipboardHistoryMax {
  if (
    typeof value === "number" &&
    HISTORY_MAX_PRESETS.includes(value as ClipboardHistoryMax)
  ) {
    return value as ClipboardHistoryMax;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (HISTORY_MAX_PRESETS.includes(n as ClipboardHistoryMax)) {
      return n as ClipboardHistoryMax;
    }
  }
  return 50;
}

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
  /**
   * Opt-in Shizuku UserService poll for background clipboard text.
   * Only active when autoClipboardSync is also on.
   */
  shizukuClipboardEnabled: boolean;
  /** Local clipboard history retention (pinned rows kept outside this cap). */
  clipboardHistoryMax: ClipboardHistoryMax;
  /** Appearance preference. Default system. */
  theme: ThemePreference;
  /** Google OAuth client ID (Android or Web) for Drive. */
  driveOAuthClientId: string;
  /** Target Drive folder id (empty = My Drive root). */
  driveFolderId: string;
  /** When true, shared/picked files can also upload to Drive. */
  driveUploadEnabled: boolean;
  /** Opt-in phone→PC folder sync from a SAF watch folder. */
  folderSyncEnabled: boolean;
  /** SAF tree URI for the watch folder (content://…). */
  folderSyncUri: string;
  /** Friendly label for the watch folder. */
  folderSyncLabel: string;
};

export const defaultMobileAppSettings: MobileAppSettings = {
  incomingFilesUri: "",
  incomingFilesLabel: "",
  allowRemoteTermux: false,
  autoClipboardSync: false,
  autoClipboardImages: true,
  shizukuClipboardEnabled: false,
  clipboardHistoryMax: 50,
  theme: "system",
  /** Default Web OAuth client (also in app.json extra.oauth). */
  driveOAuthClientId:
    "699308700646-ea3b97d997jn7g74h0jd296e75qkv7pa.apps.googleusercontent.com",
  driveFolderId: "",
  driveUploadEnabled: false,
  folderSyncEnabled: false,
  folderSyncUri: "",
  folderSyncLabel: "",
};

const defaults = defaultMobileAppSettings;

const THEME_PRESETS: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
  "amoled",
  "hacker",
  "monokai",
  "github",
];

function parseTheme(value: unknown): ThemePreference {
  if (
    typeof value === "string" &&
    (THEME_PRESETS as readonly string[]).includes(value)
  ) {
    return value as ThemePreference;
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
      shizukuClipboardEnabled:
        typeof parsed.shizukuClipboardEnabled === "boolean"
          ? parsed.shizukuClipboardEnabled
          : defaults.shizukuClipboardEnabled,
      clipboardHistoryMax: parseClipboardHistoryMax(parsed.clipboardHistoryMax),
      theme: parseTheme(parsed.theme),
      driveOAuthClientId:
        typeof parsed.driveOAuthClientId === "string" &&
        parsed.driveOAuthClientId.trim()
          ? parsed.driveOAuthClientId.trim()
          : defaults.driveOAuthClientId,
      driveFolderId:
        typeof parsed.driveFolderId === "string"
          ? parsed.driveFolderId
          : defaults.driveFolderId,
      driveUploadEnabled:
        typeof parsed.driveUploadEnabled === "boolean"
          ? parsed.driveUploadEnabled
          : defaults.driveUploadEnabled,
      folderSyncEnabled:
        typeof parsed.folderSyncEnabled === "boolean"
          ? parsed.folderSyncEnabled
          : defaults.folderSyncEnabled,
      folderSyncUri:
        typeof parsed.folderSyncUri === "string"
          ? parsed.folderSyncUri
          : defaults.folderSyncUri,
      folderSyncLabel:
        typeof parsed.folderSyncLabel === "string"
          ? parsed.folderSyncLabel
          : defaults.folderSyncLabel,
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
    shizukuClipboardEnabled:
      typeof patch.shizukuClipboardEnabled === "boolean"
        ? patch.shizukuClipboardEnabled
        : current.shizukuClipboardEnabled,
    clipboardHistoryMax:
      patch.clipboardHistoryMax !== undefined
        ? parseClipboardHistoryMax(patch.clipboardHistoryMax)
        : current.clipboardHistoryMax,
    theme: patch.theme !== undefined ? parseTheme(patch.theme) : current.theme,
    driveOAuthClientId:
      typeof patch.driveOAuthClientId === "string"
        ? patch.driveOAuthClientId.trim()
        : current.driveOAuthClientId,
    driveFolderId:
      typeof patch.driveFolderId === "string"
        ? patch.driveFolderId.trim()
        : current.driveFolderId,
    driveUploadEnabled:
      typeof patch.driveUploadEnabled === "boolean"
        ? patch.driveUploadEnabled
        : current.driveUploadEnabled,
    folderSyncEnabled:
      typeof patch.folderSyncEnabled === "boolean"
        ? patch.folderSyncEnabled
        : current.folderSyncEnabled,
    folderSyncUri:
      typeof patch.folderSyncUri === "string"
        ? patch.folderSyncUri.trim()
        : current.folderSyncUri,
    folderSyncLabel:
      typeof patch.folderSyncLabel === "string"
        ? patch.folderSyncLabel.trim()
        : current.folderSyncLabel,
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next;
}
