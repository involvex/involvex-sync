import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

export type MirroredNotification = {
  title: string;
  body: string;
  packageName?: string;
  when: number;
};

type Subscription = { remove: () => void };

type InvxNotifyNative = {
  isMirrorEnabled(): Promise<boolean>;
  setMirrorEnabled(enabled: boolean): Promise<boolean>;
  isListenerGranted(): Promise<boolean>;
  openListenerSettings(): Promise<boolean>;
  addListener(
    event: "onNotification",
    listener: (event: MirroredNotification) => void,
  ): Subscription;
};

let native: InvxNotifyNative | null = null;

try {
  native = requireNativeModule<InvxNotifyNative>("InvxNotify");
} catch {
  native = null;
}

export async function isNotifyMirrorEnabled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isMirrorEnabled();
}

export async function setNotifyMirrorEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!native) return false;
  return native.setMirrorEnabled(enabled);
}

export async function isNotifyListenerGranted(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isListenerGranted();
}

export async function openNotifyListenerSettings(): Promise<void> {
  if (!native) return;
  await native.openListenerSettings();
}

export function addNotificationMirrorListener(
  listener: (note: MirroredNotification) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onNotification", listener);
}
