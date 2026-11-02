const KEY = "invx.settings";

export type DesktopSettings = {
  /** Show mirrored phone notifications as OS toasts. Default false. */
  showPhoneNotifications: boolean;
};

const defaults: DesktopSettings = {
  showPhoneNotifications: false,
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
