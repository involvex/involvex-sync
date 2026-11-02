import { requireNativeModule } from "expo-modules-core";

type InvxKeepaliveNative = {
  start(title: string, body: string): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
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
  await native.start(title, body);
}

export async function stopKeepalive(): Promise<void> {
  if (!native) return;
  await native.stop();
}

export async function isKeepaliveRunning(): Promise<boolean> {
  if (!native) return false;
  return native.isRunning();
}
