import {
  type DeviceKeys,
  LoopGuard,
  type MessageBody,
  type PeerPublicKeys,
  clipboardUpdateBody,
  decryptFrame,
  encryptFrame,
  parseAllowedUrl,
  parseFrame,
  serializeFrame,
  shareUrlBody,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import type { StoredPeer } from "./identity";
import { type StoredDeviceKeys, toDeviceKeys } from "./identity";

export type SessionHandlers = {
  onShareUrl: (url: string, from: string) => void | Promise<void>;
  onClipboard: (text: string, from: string) => void | Promise<void>;
  onLog: (line: string) => void;
};

export class SyncSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  peer: PeerPublicKeys | null = null;
  private handlers: SessionHandlers;

  constructor(stored: StoredDeviceKeys, handlers: SessionHandlers) {
    this.local = toDeviceKeys(stored);
    this.handlers = handlers;
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
        const text =
          payload.type === "clipboard_update" ? payload.text : payload.text;
        this.loop.remember(text, body.from);
        await this.handlers.onClipboard(text, body.from);
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
}
