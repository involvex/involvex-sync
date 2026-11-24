import { requireNativeModule } from "expo";

type Subscription = { remove: () => void };

type InvxKeepaliveNative = {
  start(title: string, body: string): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  /** True after Android 15 dataSync FGS onTimeout until the next start. */
  didTimeout?(): Promise<boolean>;
  setFolderWatch(enabled: boolean): Promise<void>;
  isFolderWatchEnabled(): Promise<boolean>;
  addListener(event: "onFolderTick", listener: () => void): Subscription;
};

let native: InvxKeepaliveNative | null = null;

try {
  native = requireNativeModule<InvxKeepaliveNative>("InvxKeepalive");
} catch {
  native = null;
}

export async function startKeepalive(
  title = "involvex Sync",
  body = "Connected — waiting for links",
): Promise<void> {
  if (!native) return;
  try {
    await native.start(title, body);
  } catch (e) {
    // Quota exhausted / OEM denial — Sync still works in the foreground.
    console.warn("[invx-keepalive] start failed:", e);
  }
}

export async function stopKeepalive(): Promise<void> {
  if (!native) return;
  await native.stop();
}

export async function isKeepaliveRunning(): Promise<boolean> {
  if (!native) return false;
  return native.isRunning();
}

export async function didKeepaliveTimeout(): Promise<boolean> {
  if (!native?.didTimeout) return false;
  return native.didTimeout();
}

/** Enable/disable 2s folder-sync ticks from the foreground service. */
export async function setFolderWatch(enabled: boolean): Promise<void> {
  if (!native?.setFolderWatch) return;
  await native.setFolderWatch(enabled);
}

export async function isFolderWatchEnabled(): Promise<boolean> {
  if (!native?.isFolderWatchEnabled) return false;
  return native.isFolderWatchEnabled();
}

export function addFolderTickListener(listener: () => void): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onFolderTick", listener);
}
