const KEY = "invx.settings";

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
};

const defaults: DesktopSettings = {
  showPhoneNotifications: false,
  sendKeysToPhone: false,
  incomingFilesDir: "",
  allowRemotePwsh: false,
  folderSyncEnabled: false,
  folderSyncDir: "I:\\Downloads\\Involvex-Sync",
};

export function loadSettings(): DesktopSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...(JSON.parse(raw) as DesktopSettings) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
