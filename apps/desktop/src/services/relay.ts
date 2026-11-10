import type { DeviceKeys } from "@involvex/protocol";

const DEFAULT_RELAY = "wss://sync.involvex.workers.dev/ws";

export type RelayHandlers = {
  onMessage: (raw: string) => void;
  onStatus: (status: string) => void;
};

/**
 * Outbound WebSocket to the Cloudflare ciphertext mailbox.
 * Used when the phone is away and cannot reach the LAN listener.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: RelayHandlers;

  constructor(
    local: DeviceKeys,
    peerId: string | undefined,
    handlers: RelayHandlers,
    relayUrl = DEFAULT_RELAY,
  ) {
    const pair = peerId ? `${local.deviceId}:${peerId}` : local.deviceId;
    const base = relayUrl.replace(/\/$/, "");
    // `self` is authoritative: the worker's `A:B` guess mislabels reconnects.
    this.url = `${base}?deviceId=${encodeURIComponent(pair)}&self=${encodeURIComponent(local.deviceId)}`;
    this.handlers = handlers;
  }

  connect(): void {
    this.disconnect();
    this.handlers.onStatus(`relay connecting ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.handlers.onStatus("relay connected");
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handlers.onMessage(ev.data);
    };
    ws.onclose = () => this.handlers.onStatus("relay disconnected");
    ws.onerror = () => this.handlers.onStatus("relay error");
  }

  send(raw: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay not connected");
    }
    this.ws.send(raw);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
