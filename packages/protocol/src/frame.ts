import {
  deriveAeadKey,
  hashText,
  open,
  randomBytes,
  seal,
  sharedSecret,
  signFrame,
  verifyFrame,
} from "./crypto.js";
import { bytesToHex } from "./hex.js";
import type {
  DeviceKeys,
  MessageBody,
  MessagePayload,
  WireFrame,
} from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";
import { parseAllowedUrl } from "./url.js";

export type PeerPublicKeys = {
  deviceId: string;
  ed25519PublicKey: string;
  x25519PublicKey: string;
};

export function createMessageBody(
  from: string,
  payload: MessagePayload,
  to?: string,
): MessageBody {
  return {
    v: PROTOCOL_VERSION,
    id: bytesToHex(randomBytes(12)),
    from,
    to,
    ts: Date.now(),
    payload,
  };
}

export function encryptFrame(
  body: MessageBody,
  local: DeviceKeys,
  peer: PeerPublicKeys,
): WireFrame {
  const shared = sharedSecret(local.x25519.privateKey, peer.x25519PublicKey);
  const key = deriveAeadKey(shared);
  const { nonce, ciphertext } = seal(JSON.stringify(body), key);
  const signature = signFrame(
    PROTOCOL_VERSION,
    local.deviceId,
    nonce,
    ciphertext,
    local.ed25519.privateKey,
  );
  return {
    v: PROTOCOL_VERSION,
    from: local.deviceId,
    nonce,
    ciphertext,
    signature,
  };
}

export type DecryptResult =
  { ok: true; body: MessageBody } | { ok: false; error: string };

export function decryptFrame(
  frame: WireFrame,
  local: DeviceKeys,
  peer: PeerPublicKeys,
): DecryptResult {
  if (frame.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported protocol version ${String(frame.v)}`,
    };
  }
  if (frame.from !== peer.deviceId) {
    return { ok: false, error: "from does not match known peer" };
  }
  const valid = verifyFrame(
    frame.v,
    frame.from,
    frame.nonce,
    frame.ciphertext,
    frame.signature,
    peer.ed25519PublicKey,
  );
  if (!valid) {
    return { ok: false, error: "invalid signature" };
  }

  try {
    const shared = sharedSecret(local.x25519.privateKey, peer.x25519PublicKey);
    const key = deriveAeadKey(shared);
    const json = open(frame.ciphertext, frame.nonce, key);
    const body = JSON.parse(json) as MessageBody;
    if (body.v !== PROTOCOL_VERSION) {
      return { ok: false, error: "body version mismatch" };
    }
    if (body.from !== peer.deviceId) {
      return { ok: false, error: "body.from mismatch" };
    }
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "decrypt failed",
    };
  }
}

export function serializeFrame(frame: WireFrame): string {
  return JSON.stringify(frame);
}

export function parseFrame(raw: string): WireFrame | null {
  try {
    const parsed = JSON.parse(raw) as WireFrame;
    if (
      typeof parsed.v !== "number" ||
      typeof parsed.from !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.signature !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Build a share_url body after validating the URL. */
export function shareUrlBody(
  from: string,
  urlInput: string,
  to?: string,
): MessageBody | null {
  const url = parseAllowedUrl(urlInput);
  if (!url) return null;
  return createMessageBody(from, { type: "share_url", url }, to);
}

export function clipboardUpdateBody(
  from: string,
  text: string,
  to?: string,
): MessageBody {
  return createMessageBody(
    from,
    {
      type: "clipboard_update",
      text,
      hash: hashText(text),
    },
    to,
  );
}
