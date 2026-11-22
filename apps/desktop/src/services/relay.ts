import {
  type DeviceKeys,
  RELAY_LIVE_MAX_CHARS,
  buildRelayHello,
  normalizePairId,
  parseRelayError,
} from "@involvex/protocol";

const DEFAULT_RELAY = "wss://sync.involvex.workers.dev/ws";
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_MAX_MS = 60_000;

export type RelayHandlers = {
  onMessage: (raw: string) => void;
  onStatus: (status: string) => void;
  /** Worker rejected a frame (size / offline queue / hello). */
  onError?: (error: string) => void;
};

/**
 * Outbound WebSocket to one Cloudflare pair room (`localId:peerId`).
 * Sends a signed hello on open; reconnects with exponential backoff while
 * `wanted` until disconnect().
 */
export class RelayClient {
  readonly peerId: string | undefined;
  private ws: WebSocket | null = null;
  private url: string;
  private local: DeviceKeys;
  private handlers: RelayHandlers;
  private wanted = false;
  private helloOk = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    local: DeviceKeys,
    peerId: string | undefined,
    handlers: RelayHandlers,
    relayUrl = DEFAULT_RELAY,
  ) {
    this.local = local;
    this.peerId = peerId;
    const pair = peerId ? `${local.deviceId}:${peerId}` : local.deviceId;
    const base = relayUrl.replace(/\/$/, "");
    // `self` is authoritative: the worker's `A:B` guess mislabels reconnects.
    this.url = `${base}?deviceId=${encodeURIComponent(pair)}&self=${encodeURIComponent(local.deviceId)}`;
    this.handlers = handlers;
  }

  get roomId(): string {
    if (!this.peerId) return this.local.deviceId;
    return normalizePairId(`${this.local.deviceId}:${this.peerId}`);
  }

  get isReady(): boolean {
    return (
      this.helloOk && this.ws !== null && this.ws.readyState === WebSocket.OPEN
    );
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
    this.helloOk = false;
    this.handlers.onStatus(`relay connecting ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      if (!this.peerId) {
        this.handlers.onStatus("relay connected (no peer room)");
        return;
      }
      try {
        const hello = buildRelayHello(this.local, this.peerId);
        ws.send(JSON.stringify(hello));
        this.handlers.onStatus("relay hello sent");
      } catch (e) {
        this.handlers.onStatus(`relay hello failed: ${String(e)}`);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const raw = ev.data;
      const err = parseRelayError(raw);
      if (err) {
        this.handlers.onError?.(err.error);
        this.handlers.onStatus(`relay error: ${err.error}`);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as { ok?: string };
        if (parsed.ok === "hello") {
          this.helloOk = true;
          this.handlers.onStatus("relay connected");
          return;
        }
      } catch {
        /* sealed frame */
      }
      this.handlers.onMessage(raw);
    };
    ws.onclose = () => {
      this.ws = null;
      this.helloOk = false;
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
    if (!this.helloOk) {
      throw new Error("relay hello pending");
    }
    if (raw.length > RELAY_LIVE_MAX_CHARS) {
      throw new Error("frame too large for relay");
    }
    this.ws.send(raw);
  }

  disconnect(): void {
    this.wanted = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.helloOk = false;
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
