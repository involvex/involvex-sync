import { fingerprint } from "./crypto";
import type { DeviceIdentity, DeviceKeys, DeviceType } from "./types";
import { PROTOCOL_VERSION } from "./types";

export type PairingPayload = {
  v: typeof PROTOCOL_VERSION;
  kind: "involvex-sync-pair";
  device: DeviceIdentity;
  /** Optional LAN hint after pairing */
  host?: string;
  port?: number;
};

/** Plaintext LAN pair request (before encrypted frames). */
export type PairRequestPayload = {
  v: typeof PROTOCOL_VERSION;
  kind: "involvex-sync-pair-request";
  device: DeviceIdentity;
};

export type PairAcceptPayload = {
  v: typeof PROTOCOL_VERSION;
  kind: "involvex-sync-pair-accept";
  device: DeviceIdentity;
  host?: string;
  port?: number;
};

export type PairRejectPayload = {
  v: typeof PROTOCOL_VERSION;
  kind: "involvex-sync-pair-reject";
  deviceId: string;
  reason?: string;
};

export type PairHandshake =
  PairRequestPayload | PairAcceptPayload | PairRejectPayload;

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

export function buildPairRequest(
  keys: DeviceKeys,
  name: string,
  type: DeviceType,
): PairRequestPayload {
  return {
    v: PROTOCOL_VERSION,
    kind: "involvex-sync-pair-request",
    device: {
      deviceId: keys.deviceId,
      name,
      type,
      ed25519PublicKey: keys.ed25519.publicKey,
      x25519PublicKey: keys.x25519.publicKey,
    },
  };
}

export function buildPairAccept(
  keys: DeviceKeys,
  name: string,
  type: DeviceType,
  host?: string,
  port?: number,
): PairAcceptPayload {
  return {
    v: PROTOCOL_VERSION,
    kind: "involvex-sync-pair-accept",
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

export function buildPairReject(
  deviceId: string,
  reason?: string,
): PairRejectPayload {
  return {
    v: PROTOCOL_VERSION,
    kind: "involvex-sync-pair-reject",
    deviceId,
    reason,
  };
}

export function pairingQrText(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

function isDeviceIdentity(d: unknown): d is DeviceIdentity {
  if (!d || typeof d !== "object") return false;
  const o = d as DeviceIdentity;
  return (
    typeof o.deviceId === "string" &&
    typeof o.name === "string" &&
    typeof o.ed25519PublicKey === "string" &&
    typeof o.x25519PublicKey === "string"
  );
}

export function parsePairingQr(text: string): PairingPayload | null {
  try {
    const parsed = JSON.parse(text) as PairingPayload;
    if (parsed.kind !== "involvex-sync-pair") return null;
    if (parsed.v !== PROTOCOL_VERSION) return null;
    if (!isDeviceIdentity(parsed.device)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parsePairHandshake(raw: string): PairHandshake | null {
  try {
    const parsed = JSON.parse(raw) as PairHandshake;
    if (parsed.v !== PROTOCOL_VERSION) return null;
    switch (parsed.kind) {
      case "involvex-sync-pair-request":
        if (!isDeviceIdentity(parsed.device)) return null;
        return parsed;
      case "involvex-sync-pair-accept":
        if (!isDeviceIdentity(parsed.device)) return null;
        return parsed;
      case "involvex-sync-pair-reject":
        if (typeof parsed.deviceId !== "string") return null;
        return parsed;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function deviceFingerprint(device: DeviceIdentity): string {
  return fingerprint(device.ed25519PublicKey);
}
