import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

type InvxA11yNative = {
  isReceiveEnabled(): Promise<boolean>;
  setReceiveEnabled(enabled: boolean): Promise<boolean>;
  isServiceGranted(): Promise<boolean>;
  isServiceConnected(): Promise<boolean>;
  injectText(text: string): Promise<boolean>;
  injectKey(key: string): Promise<boolean>;
  openAccessibilitySettings(): Promise<boolean>;
};

let native: InvxA11yNative | null = null;

try {
  native = requireNativeModule<InvxA11yNative>("InvxA11y");
} catch {
  native = null;
}

export async function isA11yReceiveEnabled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isReceiveEnabled();
}

export async function setA11yReceiveEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!native) return false;
  return native.setReceiveEnabled(enabled);
}

export async function isA11yServiceGranted(): Promise<boolean> {
  if (!native) return false;
  return native.isServiceGranted();
}

export async function isA11yServiceConnected(): Promise<boolean> {
  if (!native) return false;
  return native.isServiceConnected();
}

export async function a11yInjectText(text: string): Promise<boolean> {
  if (!native) return false;
  return native.injectText(text);
}

export async function a11yInjectKey(key: string): Promise<boolean> {
  if (!native) return false;
  return native.injectKey(key);
}

export async function openAccessibilitySettings(): Promise<void> {
  if (!native) return;
  await native.openAccessibilitySettings();
}
