import { type DeviceKeys, generateDeviceKeys } from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";

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
  const existing = await invoke<StoredDeviceKeys | null>("load_device_keys");
  if (existing) return existing;

  const generated = generateDeviceKeys();
  const stored: StoredDeviceKeys = {
    deviceId: generated.deviceId,
    ed25519: generated.ed25519,
    x25519: generated.x25519,
    name: defaultName,
  };
  await invoke("save_device_keys", { keys: stored });
  return stored;
}

export async function loadPeer(): Promise<StoredPeer | null> {
  return invoke<StoredPeer | null>("load_peer");
}

export async function savePeer(peer: StoredPeer): Promise<void> {
  await invoke("save_peer", { peer });
}

export async function clearPeer(): Promise<void> {
  await invoke("clear_peer");
}
