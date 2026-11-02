import {
  type DeviceKeys,
  type DeviceType,
  LoopGuard,
  type MessageBody,
  type PairRequestPayload,
  type PeerPublicKeys,
  buildPairAccept,
  buildPairReject,
  clipboardUpdateBody,
  decryptFrame,
  encryptFrame,
  fileTransferBody,
  parseAllowedUrl,
  parseFrame,
  parsePairHandshake,
  serializeFrame,
  shareUrlBody,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import type { StoredPeer } from "./identity";
import { type StoredDeviceKeys, toDeviceKeys } from "./identity";

export type SessionHandlers = {
  onShareUrl: (url: string, from: string) => void | Promise<void>;
  onClipboard: (text: string, from: string) => void | Promise<void>;
  onFileTransfer?: (
    file: {
      name: string;
      mimeType: string;
      dataBase64: string;
      size: number;
    },
    from: string,
  ) => void | Promise<void>;
  onNotificationMirror?: (
    note: {
      title: string;
      body: string;
      packageName?: string;
      when: number;
    },
    from: string,
  ) => void | Promise<void>;
  onPairRequest?: (request: PairRequestPayload) => void | Promise<void>;
  onLog: (line: string) => void;
};

export class SyncSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  peer: PeerPublicKeys | null = null;
  private handlers: SessionHandlers;
  private identityMeta: { name: string; type: DeviceType };
  private pendingPairDeviceId: string | null = null;

  constructor(stored: StoredDeviceKeys, handlers: SessionHandlers) {
    this.local = toDeviceKeys(stored);
    this.handlers = handlers;
    this.identityMeta = { name: stored.name, type: "windows" };
  }

  setPeer(peer: StoredPeer): void {
    this.peer = {
      deviceId: peer.deviceId,
      ed25519PublicKey: peer.ed25519PublicKey,
      x25519PublicKey: peer.x25519PublicKey,
    };
  }

  clearPeer(): void {
    this.peer = null;
  }

  async handleIncomingRaw(raw: string): Promise<void> {
    const handshake = parsePairHandshake(raw);
    if (handshake) {
      if (handshake.kind === "involvex-sync-pair-request") {
        this.pendingPairDeviceId = handshake.device.deviceId;
        await this.handlers.onPairRequest?.(handshake);
        return;
      }
      return;
    }

    if (!this.peer) {
      this.handlers.onLog("drop: no peer paired");
      return;
    }
    const frame = parseFrame(raw);
    if (!frame) {
      this.handlers.onLog("drop: invalid frame json");
      return;
    }
    const result = decryptFrame(frame, this.local, this.peer);
    if (!result.ok) {
      this.handlers.onLog(`drop: ${result.error}`);
      return;
    }
    await this.dispatch(result.body);
  }

  async acceptPair(
    _request: PairRequestPayload,
    host?: string,
    port?: number,
  ): Promise<void> {
    const accept = buildPairAccept(
      this.local,
      this.identityMeta.name,
      this.identityMeta.type,
      host,
      port,
    );
    await invoke("ws_send", { message: JSON.stringify(accept) });
    this.pendingPairDeviceId = null;
  }

  async rejectPair(reason?: string): Promise<void> {
    const deviceId = this.pendingPairDeviceId ?? this.local.deviceId;
    const reject = buildPairReject(deviceId, reason);
    try {
      await invoke("ws_send", { message: JSON.stringify(reject) });
    } catch {
      /* peer may already be gone */
    }
    this.pendingPairDeviceId = null;
  }

  private async dispatch(body: MessageBody): Promise<void> {
    const { payload } = body;
    switch (payload.type) {
      case "share_url":
      case "termux_open_url": {
        const url = parseAllowedUrl(payload.url);
        if (!url) {
          this.handlers.onLog("drop: url not allowed");
          return;
        }
        await this.handlers.onShareUrl(url, body.from);
        break;
      }
      case "clipboard_update":
      case "termux_clipboard_set": {
        this.loop.remember(payload.text, body.from);
        await this.handlers.onClipboard(payload.text, body.from);
        break;
      }
      case "file_transfer": {
        await this.handlers.onFileTransfer?.(
          {
            name: payload.name,
            mimeType: payload.mimeType,
            dataBase64: payload.dataBase64,
            size: payload.size,
          },
          body.from,
        );
        break;
      }
      case "notification_mirror": {
        await this.handlers.onNotificationMirror?.(
          {
            title: payload.title,
            body: payload.body,
            packageName: payload.packageName,
            when: payload.when,
          },
          body.from,
        );
        break;
      }
      case "ping":
      case "pong":
      case "pair_ack":
        this.handlers.onLog(`recv ${payload.type}`);
        break;
      default:
        this.handlers.onLog("drop: unknown payload");
    }
  }

  async sendShareUrl(urlInput: string): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    const body = shareUrlBody(
      this.local.deviceId,
      urlInput,
      this.peer.deviceId,
    );
    if (!body) throw new Error("url not allowed");
    const frame = encryptFrame(body, this.local, this.peer);
    await invoke("ws_send", { message: serializeFrame(frame) });
  }

  async sendClipboard(text: string): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    if (this.loop.shouldSkipOutbound(text, this.local.deviceId)) {
      this.handlers.onLog("skip clipboard echo");
      return;
    }
    const body = clipboardUpdateBody(
      this.local.deviceId,
      text,
      this.peer.deviceId,
    );
    const frame = encryptFrame(body, this.local, this.peer);
    await invoke("ws_send", { message: serializeFrame(frame) });
  }

  async sendFile(file: {
    name: string;
    mimeType: string;
    dataBase64: string;
    size: number;
  }): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    const body = fileTransferBody(
      this.local.deviceId,
      file,
      this.peer.deviceId,
    );
    const frame = encryptFrame(body, this.local, this.peer);
    await invoke("ws_send", { message: serializeFrame(frame) });
  }
}
