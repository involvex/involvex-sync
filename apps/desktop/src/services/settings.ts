const KEY = "invx.settings";

export type ThemePreference = "system" | "light" | "dark";

export type DesktopSettings = {
  /** Show mirrored phone notifications as OS toasts. Default false. */
  showPhoneNotifications: boolean;
  /** Send keystrokes to the phone Sync Keyboard. Default false. */
  sendKeysToPhone: boolean;
  /** Directory for incoming files. Empty = Downloads/involvex-Sync. */
  incomingFilesDir: string;
  /** Allow phone to run PowerShell on this PC. Default false. */
  allowRemotePwsh: boolean;
  /** Watch a PC folder and push new files to the phone. Default false. */
  folderSyncEnabled: boolean;
  /** PC folder watched for outbound sync. */
  folderSyncDir: string;
  /** Auto-push OS clipboard changes to the phone while Live. Default false. */
  autoClipboardSync: boolean;
  /** Include images/screenshots in auto clipboard sync. Default true when auto on. */
  autoClipboardImages: boolean;
  /** Appearance preference. Default system. */
  theme: ThemePreference;
};

const defaults: DesktopSettings = {
  showPhoneNotifications: false,
  sendKeysToPhone: false,
  incomingFilesDir: "",
  allowRemotePwsh: false,
  folderSyncEnabled: false,
  folderSyncDir: "I:\\Downloads\\Involvex-Sync",
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

export function loadSettings(): DesktopSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    return {
      ...defaults,
      ...parsed,
      theme: parseTheme(parsed.theme),
    };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...loadSettings(), ...patch };
  if (patch.theme !== undefined) next.theme = parseTheme(patch.theme);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function resolveThemeMode(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemDark ? "dark" : "light";
}
