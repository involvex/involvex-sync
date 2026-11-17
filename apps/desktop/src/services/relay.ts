import type { DeviceKeys } from "@involvex/protocol";

const DEFAULT_RELAY = "wss://sync.involvex.workers.dev/ws";
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_MAX_MS = 60_000;

export type RelayHandlers = {
  onMessage: (raw: string) => void;
  onStatus: (status: string) => void;
};

/**
 * Outbound WebSocket to the Cloudflare ciphertext mailbox.
 * Used when the phone is away and cannot reach the LAN listener.
 * Reconnects with exponential backoff while enabled (until disconnect()).
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: RelayHandlers;
  private wanted = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.wanted = true;
    this.clearReconnectTimer();
    this.openSocket();
  }

  private openSocket(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.handlers.onStatus(`relay connecting ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.onStatus("relay connected");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handlers.onMessage(ev.data);
    };
    ws.onclose = () => {
      this.ws = null;
      this.handlers.onStatus("relay disconnected");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.handlers.onStatus("relay error");
      // onclose usually follows; if the socket never opened, close it so we
      // still enter the reconnect path.
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.wanted) return;
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts = attempt + 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(attempt, 8),
      RECONNECT_MAX_MS,
    );
    const label =
      delay >= 1000 ? `${(delay / 1000).toFixed(0)}s` : `${delay}ms`;
    this.handlers.onStatus(
      `relay reconnect in ${label} (attempt ${attempt + 1})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wanted) return;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  send(raw: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay not connected");
    }
    this.ws.send(raw);
  }

  disconnect(): void {
    this.wanted = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
