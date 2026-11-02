import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

type Subscription = { remove: () => void };

type InvxImeNative = {
  isReceiveEnabled(): Promise<boolean>;
  setReceiveEnabled(enabled: boolean): Promise<boolean>;
  isImeActive(): Promise<boolean>;
  commitText(text: string): Promise<boolean>;
  sendKey(key: string): Promise<boolean>;
  openImeSettings(): Promise<boolean>;
  addListener(
    event: "onImeActive",
    listener: (event: { active: boolean }) => void,
  ): Subscription;
};

let native: InvxImeNative | null = null;

try {
  native = requireNativeModule<InvxImeNative>("InvxIme");
} catch {
  native = null;
}

export async function isImeReceiveEnabled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isReceiveEnabled();
}

export async function setImeReceiveEnabled(enabled: boolean): Promise<boolean> {
  if (!native) return false;
  return native.setReceiveEnabled(enabled);
}

export async function isImeActive(): Promise<boolean> {
  if (!native) return false;
  return native.isImeActive();
}

export async function imeCommitText(text: string): Promise<boolean> {
  if (!native) return false;
  return native.commitText(text);
}

export async function imeSendKey(key: string): Promise<boolean> {
  if (!native) return false;
  return native.sendKey(key);
}

export async function openImeSettings(): Promise<void> {
  if (!native) return;
  await native.openImeSettings();
}

export function addImeActiveListener(
  listener: (active: boolean) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onImeActive", (e) => listener(e.active));
}
