/** Wire protocol version. Bump when frame shape breaks. */
export const PROTOCOL_VERSION = 1 as const;

/** Default LAN listen port for the desktop app. */
export const DEFAULT_PORT = 17391 as const;

export type DeviceType = "android" | "windows" | "unknown";

export type DeviceIdentity = {
  deviceId: string;
  name: string;
  type: DeviceType;
  /** Hex-encoded Ed25519 public key */
  ed25519PublicKey: string;
  /** Hex-encoded X25519 public key */
  x25519PublicKey: string;
};

export type MessageType =
  | "share_url"
  | "clipboard_update"
  | "ping"
  | "pong"
  | "pair_ack"
  | "termux_open_url"
  | "termux_clipboard_set";

export type ShareUrlPayload = {
  type: "share_url";
  url: string;
};

export type ClipboardUpdatePayload = {
  type: "clipboard_update";
  text: string;
  /** sha256 hex of text for loop detection */
  hash: string;
};

export type PingPayload = {
  type: "ping";
  ts: number;
};

export type PongPayload = {
  type: "pong";
  ts: number;
};

export type PairAckPayload = {
  type: "pair_ack";
  deviceId: string;
};

export type TermuxOpenUrlPayload = {
  type: "termux_open_url";
  url: string;
};

export type TermuxClipboardSetPayload = {
  type: "termux_clipboard_set";
  text: string;
};

export type MessagePayload =
  | ShareUrlPayload
  | ClipboardUpdatePayload
  | PingPayload
  | PongPayload
  | PairAckPayload
  | TermuxOpenUrlPayload
  | TermuxClipboardSetPayload;

/** Cleartext body sealed inside the encrypted frame. */
export type MessageBody = {
  v: typeof PROTOCOL_VERSION;
  id: string;
  /** Sender device id */
  from: string;
  /** Optional target device id */
  to?: string;
  ts: number;
  payload: MessagePayload;
};

/**
 * Signed outer envelope. Ciphertext is opaque to the relay.
 * signature covers: version || from || nonce || ciphertext
 */
export type WireFrame = {
  v: typeof PROTOCOL_VERSION;
  from: string;
  /** Hex nonce for the sealed box */
  nonce: string;
  /** Hex ciphertext (includes Poly1305 tag) */
  ciphertext: string;
  /** Hex Ed25519 signature */
  signature: string;
};

export type KeyPairHex = {
  publicKey: string;
  privateKey: string;
};

export type DeviceKeys = {
  deviceId: string;
  ed25519: KeyPairHex;
  x25519: KeyPairHex;
};
