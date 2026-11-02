import { type DeviceKeys, generateDeviceKeys } from "@involvex/protocol";
import * as SecureStore from "expo-secure-store";

const KEYS = "invx.device.keys";
const PEER = "invx.peer";

export type StoredDeviceKeys = {
  deviceId: string;
  ed25519: { publicKey: string; privateKey: string };
  x25519: { publicKey: string; privateKey: string };
  name: string;
};

export type StoredPeer = {
  deviceId: string;
  name: string;
  deviceType: string;
  ed25519PublicKey: string;
  x25519PublicKey: string;
  host?: string;
  port?: number;
};

export function toDeviceKeys(stored: StoredDeviceKeys): DeviceKeys {
  return {
    deviceId: stored.deviceId,
    ed25519: stored.ed25519,
    x25519: stored.x25519,
  };
}

export async function ensureLocalIdentity(
  defaultName: string,
): Promise<StoredDeviceKeys> {
  const raw = await SecureStore.getItemAsync(KEYS);
  if (raw) return JSON.parse(raw) as StoredDeviceKeys;

  const generated = generateDeviceKeys();
  const stored: StoredDeviceKeys = {
    deviceId: generated.deviceId,
    ed25519: generated.ed25519,
    x25519: generated.x25519,
    name: defaultName,
  };
  await SecureStore.setItemAsync(KEYS, JSON.stringify(stored));
  return stored;
}

export async function loadPeer(): Promise<StoredPeer | null> {
  const raw = await SecureStore.getItemAsync(PEER);
  if (!raw) return null;
  return JSON.parse(raw) as StoredPeer;
}

export async function savePeer(peer: StoredPeer): Promise<void> {
  await SecureStore.setItemAsync(PEER, JSON.stringify(peer));
}

export async function clearPeer(): Promise<void> {
  await SecureStore.deleteItemAsync(PEER);
}
