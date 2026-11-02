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
import type { StoredDeviceKeys, StoredPeer } from "./identity";
import { toDeviceKeys } from "./identity";
import { type TransportConfig, resolveWsUrl } from "./transport";

export type SessionHandlers = {
  onShareUrl: (url: string, from: string) => void | Promise<void>;
  onClipboard: (text: string, from: string) => void | Promise<void>;
  onStatus: (status: string) => void;
  onLog: (line: string) => void;
};

export class MobileSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  peer: PeerPublicKeys | null = null;
  private ws: WebSocket | null = null;
  private handlers: SessionHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private transport: TransportConfig | null = null;
  private peerId: string | undefined;

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
    this.peerId = peer.deviceId;
  }

  clearPeer(): void {
    this.peer = null;
    this.peerId = undefined;
  }

  connect(transport: TransportConfig): void {
    this.disconnect();
    this.transport = transport;
    let url: string;
    try {
      url = resolveWsUrl(transport, this.local.deviceId, this.peerId);
    } catch (e) {
      this.handlers.onStatus(`error: ${String(e)}`);
      return;
    }

    this.handlers.onStatus(`connecting ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onStatus(`connected (${transport.mode})`);
    };
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      void this.handleIncomingRaw(raw);
    };
    ws.onerror = () => {
      this.handlers.onStatus("socket error");
    };
    ws.onclose = () => {
      this.handlers.onStatus("disconnected");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.transport) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.transport) this.connect(this.transport);
    }, 2_500);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  async handleIncomingRaw(raw: string): Promise<void> {
    if (!this.peer) {
      this.handlers.onLog("drop: no peer");
      return;
    }
    const frame = parseFrame(raw);
    if (!frame) {
      this.handlers.onLog("drop: bad frame");
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
        if (!url) return;
        await this.handlers.onShareUrl(url, body.from);
        break;
      }
      case "clipboard_update":
      case "termux_clipboard_set": {
        this.loop.remember(payload.text, body.from);
        await this.handlers.onClipboard(payload.text, body.from);
        break;
      }
      default:
        this.handlers.onLog(`recv ${payload.type}`);
    }
  }

  sendShareUrl(urlInput: string): void {
    if (!this.peer || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const body = shareUrlBody(
      this.local.deviceId,
      urlInput,
      this.peer.deviceId,
    );
    if (!body) throw new Error("url not allowed");
    const frame = encryptFrame(body, this.local, this.peer);
    this.ws.send(serializeFrame(frame));
  }

  sendClipboard(text: string): void {
    if (!this.peer || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
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
    this.ws.send(serializeFrame(frame));
  }
}
