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
  /** Last LAN address this peer was reached on. */
  host?: string;
  port?: number;
};

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

export function toDeviceKeys(stored: StoredDeviceKeys): DeviceKeys {
  return {
    deviceId: stored.deviceId,
    ed25519: stored.ed25519,
    x25519: stored.x25519,
  };
}

export type PeerLoadResult = {
  peers: StoredPeer[];
  /** True when a legacy single-peer keyring entry was folded in. */
  migrated: boolean;
};

/** All paired devices (phone + second PC + laptop). */
export async function loadPeers(): Promise<StoredPeer[]> {
  const result = await invoke<PeerLoadResult>("load_peers");
  return result.peers;
}

export async function savePeer(peer: StoredPeer): Promise<StoredPeer[]> {
  return invoke<StoredPeer[]>("save_peer", { peer });
}

export async function removePeer(deviceId: string): Promise<StoredPeer[]> {
  return invoke<StoredPeer[]>("remove_peer", { deviceId });
}

export async function clearPeers(): Promise<void> {
  await invoke("clear_peer");
}

export async function touchPeer(
  deviceId: string,
  host: string,
  port: number,
): Promise<void> {
  await invoke("touch_peer", { deviceId, host, port });
}
