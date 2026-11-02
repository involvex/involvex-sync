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
  | "termux_clipboard_set"
  | "file_transfer"
  | "file_offer"
  | "file_chunk"
  | "file_done"
  | "file_abort"
  | "notification_mirror"
  | "keyboard_text"
  | "keyboard_key"
  | "keyboard_status"
  | "find_phone";

/** Max decoded file size for legacy single-shot base64 transfer (2 MiB). */
export const MAX_FILE_TRANSFER_BYTES = 2 * 1024 * 1024;

/** Soft cap for chunked transfers (100 MiB). */
export const MAX_CHUNKED_FILE_BYTES = 100 * 1024 * 1024;

/** Decoded chunk size for file_chunk payloads (~64 KiB). */
export const FILE_CHUNK_BYTES = 64 * 1024;

/** Max characters per keyboard_text frame. */
export const MAX_KEYBOARD_TEXT_CHARS = 2000;

export type KeyboardKeyId =
  | "enter"
  | "backspace"
  | "tab"
  | "escape"
  | "arrow_left"
  | "arrow_right"
  | "arrow_up"
  | "arrow_down"
  | "delete";

export const KEYBOARD_KEY_IDS: readonly KeyboardKeyId[] = [
  "enter",
  "backspace",
  "tab",
  "escape",
  "arrow_left",
  "arrow_right",
  "arrow_up",
  "arrow_down",
  "delete",
] as const;

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

export type FileTransferPayload = {
  type: "file_transfer";
  name: string;
  mimeType: string;
  /** Base64 file bytes (≤ MAX_FILE_TRANSFER_BYTES). */
  dataBase64: string;
  size: number;
};

export type FileOfferPayload = {
  type: "file_offer";
  transferId: string;
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
};

export type FileChunkPayload = {
  type: "file_chunk";
  transferId: string;
  index: number;
  /** Base64 of this chunk only. */
  dataBase64: string;
};

export type FileDonePayload = {
  type: "file_done";
  transferId: string;
  /** sha256 hex of full decoded file. */
  sha256: string;
};

export type FileAbortPayload = {
  type: "file_abort";
  transferId: string;
  reason?: string;
};

/** Mirrored Android notification (title/body only). */
export type NotificationMirrorPayload = {
  type: "notification_mirror";
  title: string;
  body: string;
  packageName?: string;
  when: number;
};

export type KeyboardTextPayload = {
  type: "keyboard_text";
  text: string;
};

export type KeyboardKeyPayload = {
  type: "keyboard_key";
  key: KeyboardKeyId;
};

export type KeyboardStatusPayload = {
  type: "keyboard_status";
  active: boolean;
};

export type FindPhonePayload = {
  type: "find_phone";
  /** How long the phone should ring, ms. */
  durationMs: number;
};

export type MessagePayload =
  | ShareUrlPayload
  | ClipboardUpdatePayload
  | PingPayload
  | PongPayload
  | PairAckPayload
  | TermuxOpenUrlPayload
  | TermuxClipboardSetPayload
  | FileTransferPayload
  | FileOfferPayload
  | FileChunkPayload
  | FileDonePayload
  | FileAbortPayload
  | NotificationMirrorPayload
  | KeyboardTextPayload
  | KeyboardKeyPayload
  | KeyboardStatusPayload
  | FindPhonePayload;

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
