import {
  deriveAeadKey,
  hashText,
  open,
  randomBytes,
  seal,
  sharedSecret,
  signFrame,
  verifyFrame,
} from "./crypto";
import { bytesToHex } from "./hex";
import type {
  DeviceKeys,
  KeyboardKeyId,
  KeyboardReceiverMode,
  MessageBody,
  MessagePayload,
  RemoteShell,
  WireFrame,
} from "./types";
import {
  KEYBOARD_KEY_IDS,
  MAX_KEYBOARD_TEXT_CHARS,
  MAX_REMOTE_COMMAND_CHARS,
  MAX_REMOTE_OUTPUT_CHARS,
  PROTOCOL_VERSION,
} from "./types";
import { parseAllowedUrl } from "./url";

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

export function fileTransferBody(
  from: string,
  file: {
    name: string;
    mimeType: string;
    dataBase64: string;
    size: number;
  },
  to?: string,
): MessageBody {
  return createMessageBody(
    from,
    {
      type: "file_transfer",
      name: file.name,
      mimeType: file.mimeType,
      dataBase64: file.dataBase64,
      size: file.size,
    },
    to,
  );
}

export function notificationMirrorBody(
  from: string,
  note: {
    title: string;
    body: string;
    packageName?: string;
    when?: number;
  },
  to?: string,
): MessageBody {
  return createMessageBody(
    from,
    {
      type: "notification_mirror",
      title: note.title.slice(0, 200),
      body: note.body.slice(0, 500),
      packageName: note.packageName,
      when: note.when ?? Date.now(),
    },
    to,
  );
}

export function isKeyboardKeyId(key: string): key is KeyboardKeyId {
  return (KEYBOARD_KEY_IDS as readonly string[]).includes(key);
}

export function keyboardTextBody(
  from: string,
  text: string,
  to?: string,
): MessageBody | null {
  const trimmed = text.slice(0, MAX_KEYBOARD_TEXT_CHARS);
  if (!trimmed) return null;
  return createMessageBody(from, { type: "keyboard_text", text: trimmed }, to);
}

export function keyboardKeyBody(
  from: string,
  key: KeyboardKeyId,
  to?: string,
): MessageBody | null {
  if (!isKeyboardKeyId(key)) return null;
  return createMessageBody(from, { type: "keyboard_key", key }, to);
}

export function keyboardStatusBody(
  from: string,
  active: boolean,
  to?: string,
  mode?: KeyboardReceiverMode,
): MessageBody {
  return createMessageBody(
    from,
    mode
      ? { type: "keyboard_status", active, mode }
      : { type: "keyboard_status", active },
    to,
  );
}

export function findPhoneBody(
  from: string,
  durationMs = 30_000,
  to?: string,
): MessageBody {
  return createMessageBody(
    from,
    {
      type: "find_phone",
      durationMs: Math.min(Math.max(durationMs, 5_000), 60_000),
    },
    to,
  );
}

export function fileOfferBody(
  from: string,
  offer: {
    transferId: string;
    name: string;
    mimeType: string;
    size: number;
    totalChunks: number;
  },
  to?: string,
): MessageBody {
  return createMessageBody(from, { type: "file_offer", ...offer }, to);
}

export function fileChunkBody(
  from: string,
  chunk: { transferId: string; index: number; dataBase64: string },
  to?: string,
): MessageBody {
  return createMessageBody(from, { type: "file_chunk", ...chunk }, to);
}

export function fileDoneBody(
  from: string,
  done: { transferId: string; sha256: string },
  to?: string,
): MessageBody {
  return createMessageBody(from, { type: "file_done", ...done }, to);
}

export function fileAbortBody(
  from: string,
  abort: { transferId: string; reason?: string },
  to?: string,
): MessageBody {
  return createMessageBody(from, { type: "file_abort", ...abort }, to);
}

export function remoteCommandBody(
  from: string,
  cmd: {
    requestId: string;
    shell: RemoteShell;
    command: string;
    timeoutMs?: number;
  },
  to?: string,
): MessageBody | null {
  const command = cmd.command.trim().slice(0, MAX_REMOTE_COMMAND_CHARS);
  if (!command || !cmd.requestId) return null;
  if (cmd.shell !== "pwsh" && cmd.shell !== "termux" && cmd.shell !== "adb") {
    return null;
  }
  return createMessageBody(
    from,
    {
      type: "remote_command",
      requestId: cmd.requestId,
      shell: cmd.shell,
      command,
      timeoutMs: cmd.timeoutMs,
    },
    to,
  );
}

export function remoteCommandResultBody(
  from: string,
  result: {
    requestId: string;
    ok: boolean;
    exitCode?: number;
    stdout: string;
    stderr: string;
  },
  to?: string,
): MessageBody | null {
  if (!result.requestId) return null;
  return createMessageBody(
    from,
    {
      type: "remote_command_result",
      requestId: result.requestId,
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, MAX_REMOTE_OUTPUT_CHARS),
      stderr: result.stderr.slice(0, MAX_REMOTE_OUTPUT_CHARS),
    },
    to,
  );
}
