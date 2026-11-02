import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

export type DiscoveredService = {
  name: string;
  deviceId: string;
  host: string;
  port: number;
  type: string;
};

type Subscription = { remove: () => void };

type InvxMdnsNative = {
  startBrowse(): Promise<boolean>;
  stopBrowse(): Promise<boolean>;
  addListener(
    event: "onServiceFound",
    listener: (event: DiscoveredService) => void,
  ): Subscription;
  addListener(
    event: "onServiceLost",
    listener: (event: { name: string; deviceId: string }) => void,
  ): Subscription;
  addListener(
    event: "onError",
    listener: (event: { message: string }) => void,
  ): Subscription;
};

let native: InvxMdnsNative | null = null;

try {
  native = requireNativeModule<InvxMdnsNative>("InvxMdns");
} catch {
  native = null;
}

export async function startMdnsBrowse(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false;
  return native.startBrowse();
}

export async function stopMdnsBrowse(): Promise<boolean> {
  if (!native) return false;
  return native.stopBrowse();
}

export function addMdnsServiceFoundListener(
  listener: (service: DiscoveredService) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onServiceFound", listener);
}

export function addMdnsServiceLostListener(
  listener: (service: { name: string; deviceId: string }) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onServiceLost", listener);
}

export function addMdnsErrorListener(
  listener: (error: { message: string }) => void,
): Subscription {
  if (!native?.addListener) return { remove: () => undefined };
  return native.addListener("onError", listener);
}
