import { fingerprint } from "./crypto.js";
import type { DeviceIdentity, DeviceKeys, DeviceType } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export type PairingPayload = {
  v: typeof PROTOCOL_VERSION;
  kind: "involvex-sync-pair";
  device: DeviceIdentity;
  /** Optional LAN hint after pairing */
  host?: string;
  port?: number;
};

export function buildPairingPayload(
  keys: DeviceKeys,
  name: string,
  type: DeviceType,
  host?: string,
  port?: number,
): PairingPayload {
  return {
    v: PROTOCOL_VERSION,
    kind: "involvex-sync-pair",
    device: {
      deviceId: keys.deviceId,
      name,
      type,
      ed25519PublicKey: keys.ed25519.publicKey,
      x25519PublicKey: keys.x25519.publicKey,
    },
    host,
    port,
  };
}

export function pairingQrText(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

export function parsePairingQr(text: string): PairingPayload | null {
  try {
    const parsed = JSON.parse(text) as PairingPayload;
    if (parsed.kind !== "involvex-sync-pair") return null;
    if (parsed.v !== PROTOCOL_VERSION) return null;
    if (!parsed.device?.deviceId) return null;
    if (!parsed.device.ed25519PublicKey || !parsed.device.x25519PublicKey) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function deviceFingerprint(device: DeviceIdentity): string {
  return fingerprint(device.ed25519PublicKey);
}
