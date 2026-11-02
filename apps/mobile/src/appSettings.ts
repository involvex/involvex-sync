import * as SecureStore from "expo-secure-store";

const KEY = "invx.mobile.appSettings";

export type MobileAppSettings = {
  /** Relative folder under documentDirectory for incoming files. */
  incomingFilesDir: string;
  /** Allow PC to run Termux commands on this phone. Default false. */
  allowRemoteTermux: boolean;
};

const defaults: MobileAppSettings = {
  incomingFilesDir: "involvex-Sync",
  allowRemoteTermux: false,
};

export async function loadAppSettings(): Promise<MobileAppSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...(JSON.parse(raw) as MobileAppSettings) };
  } catch {
    return { ...defaults };
  }
}

export async function saveAppSettings(
  patch: Partial<MobileAppSettings>,
): Promise<MobileAppSettings> {
  const current = await loadAppSettings();
  const next: MobileAppSettings = {
    incomingFilesDir:
      typeof patch.incomingFilesDir === "string" &&
      patch.incomingFilesDir.trim()
        ? patch.incomingFilesDir.trim().replace(/[\\/]+/g, "/")
        : current.incomingFilesDir,
    allowRemoteTermux:
      typeof patch.allowRemoteTermux === "boolean"
        ? patch.allowRemoteTermux
        : current.allowRemoteTermux,
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next;
}
