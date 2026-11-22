import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "./crypto";
import { bytesToHex, hexToBytes } from "./hex";
import { normalizePairId } from "./relayLimits";
import type { DeviceKeys } from "./types";

const utf8 = new TextEncoder();

/** Cleartext hello the relay verifies before admitting a socket to a pair room. */
export type RelayHello = {
  kind: "involvex-sync-relay-hello";
  deviceId: string;
  roomId: string;
  ed25519PublicKey: string;
  nonce: string;
  ts: number;
  signature: string;
};

/** Bytes Ed25519 signs for a relay hello. */
export function relayHelloSignInput(
  deviceId: string,
  roomId: string,
  ed25519PublicKey: string,
  nonce: string,
  ts: number,
): Uint8Array {
  return utf8.encode(
    `involvex-sync-relay-hello|${deviceId}|${roomId}|${ed25519PublicKey}|${nonce}|${ts}`,
  );
}

export function buildRelayHello(local: DeviceKeys, peerId: string): RelayHello {
  const roomId = normalizePairId(`${local.deviceId}:${peerId}`);
  const nonce = bytesToHex(randomBytes(16));
  const ts = Date.now();
  const ed25519PublicKey = local.ed25519.publicKey;
  const msg = relayHelloSignInput(
    local.deviceId,
    roomId,
    ed25519PublicKey,
    nonce,
    ts,
  );
  const signature = bytesToHex(
    ed25519.sign(msg, hexToBytes(local.ed25519.privateKey)),
  );
  return {
    kind: "involvex-sync-relay-hello",
    deviceId: local.deviceId,
    roomId,
    ed25519PublicKey,
    nonce,
    ts,
    signature,
  };
}

export function parseRelayHello(raw: string): RelayHello | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RelayHello>;
    if (parsed.kind !== "involvex-sync-relay-hello") return null;
    if (
      typeof parsed.deviceId !== "string" ||
      typeof parsed.roomId !== "string" ||
      typeof parsed.ed25519PublicKey !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.ts !== "number" ||
      typeof parsed.signature !== "string"
    ) {
      return null;
    }
    return {
      kind: "involvex-sync-relay-hello",
      deviceId: parsed.deviceId,
      roomId: parsed.roomId,
      ed25519PublicKey: parsed.ed25519PublicKey,
      nonce: parsed.nonce,
      ts: parsed.ts,
      signature: parsed.signature,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a hello against the expected room. Optionally require a previously
 * pinned public key (reconnect / takeover protection).
 */
export function verifyRelayHello(
  hello: RelayHello,
  expectedRoomId: string,
  pinnedPublicKey?: string | null,
): boolean {
  if (hello.roomId !== expectedRoomId) return false;
  if (hello.deviceId.length === 0 || hello.deviceId.includes(":")) return false;
  if (hello.ed25519PublicKey.length !== 64) return false;
  if (hello.nonce.length < 16 || hello.nonce.length > 128) return false;
  if (!Number.isFinite(hello.ts)) return false;
  // Reject clocks more than 10 minutes off (replay window).
  if (Math.abs(Date.now() - hello.ts) > 10 * 60_000) return false;
  if (pinnedPublicKey && pinnedPublicKey !== hello.ed25519PublicKey) {
    return false;
  }
  try {
    const msg = relayHelloSignInput(
      hello.deviceId,
      hello.roomId,
      hello.ed25519PublicKey,
      hello.nonce,
      hello.ts,
    );
    return ed25519.verify(
      hexToBytes(hello.signature),
      msg,
      hexToBytes(hello.ed25519PublicKey),
    );
  } catch {
    return false;
  }
}

/** Worker / client error envelope on the relay socket (not a sealed frame). */
export type RelayErrorMessage = {
  error: string;
};

export function parseRelayError(raw: string): RelayErrorMessage | null {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error !== "string" || parsed.error.length === 0) {
      return null;
    }
    // Hello / pair / wire frames also have other fields — only treat pure errors.
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "error") return null;
    return { error: parsed.error };
  } catch {
    return null;
  }
}
