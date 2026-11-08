/**
 * Ciphertext-only mailbox between a paired phone and desktop.
 * Uses hibernatable WebSockets so idle pairs do not burn Free-plan duration.
 *
 * Google OAuth lives in workers/oauth-token-exchange (not here).
 */

export interface Env {
  PAIR_ROOM: DurableObjectNamespace;
}

type QueuedFrame = {
  from: string;
  raw: string;
  ts: number;
};

const QUEUE_TTL_MS = 5 * 60_000;
const QUEUE_MAX = 32;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "involvex-sync-relay",
        note: "ciphertext mailbox only",
      });
    }

    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const devicePair = url.searchParams.get("deviceId");
    if (!devicePair || devicePair.length > 200) {
      return new Response("deviceId required", { status: 400 });
    }

    // Pair room id is stable for A:B regardless of who connects first.
    const roomId = normalizePairId(devicePair);
    const id = env.PAIR_ROOM.idFromName(roomId);
    const stub = env.PAIR_ROOM.get(id);
    return stub.fetch(request);
  },
};

function normalizePairId(raw: string): string {
  const parts = raw.split(":").filter(Boolean);
  if (parts.length === 2) {
    return [...parts].sort().join(":");
  }
  return raw;
}

export class PairRoom implements DurableObject {
  private state: DurableObjectState;
  /** deviceId → websocket */
  private sessions = new Map<string, WebSocket>();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pairParam = url.searchParams.get("deviceId") ?? "";
    const deviceId = pairParam.includes(":")
      ? guessSelfId(pairParam, this.sessions)
      : pairParam;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server, [deviceId]);
    this.sessions.set(deviceId, server);

    // Flush short offline queue for this device.
    const queue = (await this.state.storage.get<QueuedFrame[]>("queue")) ?? [];
    const keep: QueuedFrame[] = [];
    const now = Date.now();
    for (const item of queue) {
      if (now - item.ts > QUEUE_TTL_MS) continue;
      if (item.from === deviceId) {
        keep.push(item);
        continue;
      }
      try {
        server.send(item.raw);
      } catch {
        keep.push(item);
      }
    }
    await this.state.storage.put("queue", keep.slice(-QUEUE_MAX));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const raw =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    let from: string;
    try {
      const parsed = JSON.parse(raw) as { from?: string };
      from = typeof parsed.from === "string" ? parsed.from : "";
    } catch {
      ws.send(JSON.stringify({ error: "invalid json frame" }));
      return;
    }

    // Relay never decrypts. Optional: reject oversized frames.
    if (raw.length > 64_000) {
      ws.send(JSON.stringify({ error: "frame too large" }));
      return;
    }

    let delivered = false;
    for (const [id, peer] of this.sessions) {
      if (peer === ws) continue;
      if (from && id === from) continue;
      try {
        peer.send(raw);
        delivered = true;
      } catch {
        this.sessions.delete(id);
      }
    }

    if (!delivered) {
      const queue =
        (await this.state.storage.get<QueuedFrame[]>("queue")) ?? [];
      queue.push({ from, raw, ts: Date.now() });
      await this.state.storage.put("queue", queue.slice(-QUEUE_MAX));
    }
  }

  webSocketClose(ws: WebSocket) {
    for (const [id, sock] of this.sessions) {
      if (sock === ws) this.sessions.delete(id);
    }
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }
}

function guessSelfId(
  pairParam: string,
  sessions: Map<string, WebSocket>,
): string {
  const [a, b] = pairParam.split(":");
  if (!a || !b) return pairParam;
  if (!sessions.has(a)) return a;
  if (!sessions.has(b)) return b;
  // Both already present — replace the older slot for this connector using a.
  return a;
}
