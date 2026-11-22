const KEY = "invx.settings";

export type ThemePreference =
  "system" | "light" | "dark" | "amoled" | "hacker" | "monokai" | "github";

export type ResolvedTheme = Exclude<ThemePreference, "system">;

const THEME_PRESETS: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
  "amoled",
  "hacker",
  "monokai",
  "github",
] as const;

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
  /** Upload watched-folder files to Google Drive via gws. Default false. */
  driveSyncEnabled: boolean;
  /** Drive folder id for uploads (empty = My Drive root). */
  driveSyncFolderId: string;
  /** Auto-push OS clipboard changes to the phone while Live. Default false. */
  autoClipboardSync: boolean;
  /** Include images/screenshots in auto clipboard sync. Default true when auto on. */
  autoClipboardImages: boolean;
  /** Appearance preference. Default system. */
  theme: ThemePreference;
  /** Preferred adb device serial. Empty = auto-pick (hint only; mDNS serials change on reconnect). */
  adbSerial: string;
  /** Absolute path to scrcpy.exe (empty = PATH / Escrcpy bundle / ESCRCPY_SCRCPY). */
  scrcpyPath: string;
  /** Absolute path to Escrcpy.exe (empty = PATH / common install dirs). */
  escrcpyExePath: string;
  /** Extra scrcpy CLI flags, space-separated (e.g. `--max-size=1024 --no-audio`). */
  scrcpyExtraArgs: string;
  /** Allow phone to request a local adb screencap on this PC. Default false. */
  allowRemoteAdbScreencap: boolean;
  /**
   * Keep a Cloudflare relay room open for every paired device (away-from-home
   * fallback). Persisted so a reboot still dials the relay.
   */
  relayEnabled: boolean;
};

const defaults: DesktopSettings = {
  showPhoneNotifications: false,
  sendKeysToPhone: false,
  incomingFilesDir: "",
  allowRemotePwsh: false,
  folderSyncEnabled: false,
  folderSyncDir: "I:\\Downloads\\Involvex-Sync",
  driveSyncEnabled: false,
  driveSyncFolderId: "",
  autoClipboardSync: false,
  autoClipboardImages: true,
  theme: "system",
  adbSerial: "",
  scrcpyPath: "",
  escrcpyExePath: "",
  scrcpyExtraArgs: "",
  allowRemoteAdbScreencap: false,
  relayEnabled: false,
};

function parseTheme(value: unknown): ThemePreference {
  if (
    typeof value === "string" &&
    (THEME_PRESETS as readonly string[]).includes(value)
  ) {
    return value as ThemePreference;
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

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}
