import { Platform } from "react-native";
import { requireNativeModule } from "expo";

export type ClipboardImageEvent = {
  mimeType: string;
  dataBase64: string;
  size: number;
  name: string;
};

type Subscription = { remove: () => void };

export type ClipboardShizukuStatus = {
  status: string;
  available: boolean;
  authorized: boolean;
  listening: boolean;
};

type InvxClipboardNative = {
  isAutoEnabled(): Promise<boolean>;
  setAutoEnabled(enabled: boolean): Promise<boolean>;
  isIncludeImages(): Promise<boolean>;
  setIncludeImages(enabled: boolean): Promise<boolean>;
  setImeActive(active: boolean): Promise<boolean>;
  setClipboardImage(dataBase64: string, mimeType: string): Promise<boolean>;
  compressImage(
    dataBase64: string,
    maxBytes: number,
  ): Promise<ClipboardImageEvent | null>;
  isShizukuEnabled(): Promise<boolean>;
  setShizukuEnabled(enabled: boolean): Promise<boolean>;
  getShizukuStatus(): Promise<ClipboardShizukuStatus>;
  addListener(
    event: "onClipboardText",
    listener: (event: { text: string }) => void,
  ): Subscription;
  addListener(
    event: "onClipboardImage",
    listener: (event: ClipboardImageEvent) => void,
  ): Subscription;
};

let native: InvxClipboardNative | null = null;

try {
  native = requireNativeModule<InvxClipboardNative>("InvxClipboard");
} catch {
  native = null;
}

export async function isClipboardAutoEnabled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.isAutoEnabled();
}

export async function setClipboardAutoEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!native) return false;
  return native.setAutoEnabled(enabled);
}

export async function isClipboardIncludeImages(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return true;
  return native.isIncludeImages();
}

export async function setClipboardIncludeImages(
  enabled: boolean,
): Promise<boolean> {
  if (!native) return false;
  return native.setIncludeImages(enabled);
}

export async function setClipboardImeActive(active: boolean): Promise<void> {
  if (!native) return;
  await native.setImeActive(active);
}

export async function setNativeClipboardImage(
  dataBase64: string,
  mimeType: string,
): Promise<boolean> {
  if (!native) return false;
  return native.setClipboardImage(dataBase64, mimeType);
}

export async function compressClipboardImageNative(
  dataBase64: string,
  maxBytes: number,
): Promise<ClipboardImageEvent | null> {
  if (!native) return null;
  return native.compressImage(dataBase64, maxBytes);
}

export async function isClipboardShizukuEnabled(): Promise<boolean> {
  if (Platform.OS !== "android" || !native?.isShizukuEnabled) return false;
  return native.isShizukuEnabled();
}

export async function setClipboardShizukuEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!native?.setShizukuEnabled) return false;
  return native.setShizukuEnabled(enabled);
}

export async function getClipboardShizukuStatus(): Promise<ClipboardShizukuStatus> {
  if (Platform.OS !== "android" || !native?.getShizukuStatus) {
    return {
      status: "unavailable",
      available: false,
      authorized: false,
      listening: false,
    };
  }
  return native.getShizukuStatus();
}

export function addClipboardTextListener(
  listener: (text: string) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onClipboardText", (e) => listener(e.text));
}

export function addClipboardImageListener(
  listener: (image: ClipboardImageEvent) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onClipboardImage", listener);
}
