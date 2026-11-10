import { type DeviceKeys, generateDeviceKeys } from "@involvex/protocol";
import * as SecureStore from "expo-secure-store";

const KEYS = "invx.device.keys";
/** Deprecated single-peer slot; read once for migration. */
const PEER = "invx.peer";
const PEERS = "invx.peers";

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

/**
 * All paired devices. Folds in the legacy single-peer entry once so an
 * upgrading install keeps its pairing.
 */
export async function loadPeers(): Promise<StoredPeer[]> {
  const raw = await SecureStore.getItemAsync(PEERS);
  let peers: StoredPeer[] = [];
  if (raw) {
    try {
      peers = JSON.parse(raw) as StoredPeer[];
    } catch {
      peers = [];
    }
  }

  const legacyRaw = await SecureStore.getItemAsync(PEER);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as StoredPeer;
      if (
        legacy.deviceId &&
        !peers.some((p) => p.deviceId === legacy.deviceId)
      ) {
        peers.push(legacy);
        await writePeers(peers);
      }
    } catch {
      /* malformed legacy entry — drop it */
    }
    await SecureStore.deleteItemAsync(PEER);
  }

  return peers;
}

export async function savePeer(peer: StoredPeer): Promise<StoredPeer[]> {
  const peers = await loadPeers();
  const idx = peers.findIndex((p) => p.deviceId === peer.deviceId);
  if (idx >= 0) peers[idx] = { ...peers[idx], ...peer };
  else peers.push(peer);
  await writePeers(peers);
  return peers;
}

export async function removePeer(deviceId: string): Promise<StoredPeer[]> {
  const peers = await loadPeers();
  const list = peers.filter((p) => p.deviceId !== deviceId);
  await writePeers(list);
  return list;
}

export async function clearPeers(): Promise<void> {
  await SecureStore.deleteItemAsync(PEERS);
  await SecureStore.deleteItemAsync(PEER);
}

async function writePeers(peers: StoredPeer[]): Promise<void> {
  await SecureStore.setItemAsync(PEERS, JSON.stringify(peers));
}
