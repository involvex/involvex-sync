/**
 * Ciphertext-only mailbox between a paired phone and desktop.
 * Uses hibernatable WebSockets so idle pairs do not burn Free-plan duration.
 *
 * Google OAuth lives in workers/oauth-token-exchange (not here).
 */

import {
  RELAY_LIVE_MAX_CHARS,
  RELAY_QUEUE_MAX,
  RELAY_QUEUE_MAX_CHARS,
  RELAY_QUEUE_TTL_MS,
  normalizePairId,
  parseRelayHello,
  verifyRelayHello,
} from "@involvex/protocol";

export interface Env {
  PAIR_ROOM: DurableObjectNamespace;
}

type QueuedFrame = {
  from: string;
  raw: string;
  ts: number;
};

type PendingSession = {
  ws: WebSocket;
  deviceId: string;
  roomId: string;
  connectedAt: number;
};

const HELLO_TIMEOUT_MS = 15_000;

export { normalizePairId };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "involvex-sync-relay",
        note: "ciphertext mailbox only",
        liveMaxChars: RELAY_LIVE_MAX_CHARS,
        queueMaxChars: RELAY_QUEUE_MAX_CHARS,
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

export class PairRoom implements DurableObject {
  private state: DurableObjectState;
  /** deviceId → websocket (admitted after a verified hello). */
  private sessions = new Map<string, WebSocket>();
  /** Sockets waiting for a signed hello before they can replace / flush. */
  private pending = new Map<WebSocket, PendingSession>();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pairParam = url.searchParams.get("deviceId") ?? "";
    const roomId = normalizePairId(pairParam);
    // Explicit self id wins: the old heuristic (first free half of `A:B`)
    // mislabelled a *reconnecting* device — if A reconnected while B was
    // absent it took B's slot and the pair stopped delivering.
    const deviceId = resolveDeviceId(
      pairParam,
      url.searchParams.get("self"),
      this.sessions,
    );

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Do not replace the live session yet — wait for a verified hello so a
    // client that only knows the two device ids cannot take the room.
    this.state.acceptWebSocket(server, [`pending:${deviceId}`]);
    this.pending.set(server, {
      ws: server,
      deviceId,
      roomId,
      connectedAt: Date.now(),
    });

    // Drop pending sockets that never hello.
    await this.state.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const [ws, pending] of this.pending) {
      if (now - pending.connectedAt < HELLO_TIMEOUT_MS) continue;
      this.pending.delete(ws);
      try {
        ws.send(JSON.stringify({ error: "hello timeout" }));
      } catch {
        /* ignore */
      }
      try {
        ws.close(1000, "hello timeout");
      } catch {
        /* ignore */
      }
    }
    if (this.pending.size > 0) {
      await this.state.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const raw =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    const pending = this.pending.get(ws);
    if (pending) {
      await this.handleHello(ws, pending, raw);
      return;
    }

    let from: string;
    try {
      const parsed = JSON.parse(raw) as { from?: string };
      from = typeof parsed.from === "string" ? parsed.from : "";
    } catch {
      ws.send(JSON.stringify({ error: "invalid json frame" }));
      return;
    }

    // Live forward fits a sealed file_chunk; larger frames are rejected.
    if (raw.length > RELAY_LIVE_MAX_CHARS) {
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
      // Offline mailbox is for small frames only (clipboard/link/notes/commands).
      if (raw.length > RELAY_QUEUE_MAX_CHARS) {
        ws.send(
          JSON.stringify({ error: "peer offline; frame too large to queue" }),
        );
        return;
      }
      const queue =
        (await this.state.storage.get<QueuedFrame[]>("queue")) ?? [];
      queue.push({ from, raw, ts: Date.now() });
      await this.state.storage.put("queue", queue.slice(-RELAY_QUEUE_MAX));
    }
  }

  private async handleHello(
    ws: WebSocket,
    pending: PendingSession,
    raw: string,
  ): Promise<void> {
    const hello = parseRelayHello(raw);
    if (!hello) {
      ws.send(JSON.stringify({ error: "hello required" }));
      return;
    }
    if (hello.deviceId !== pending.deviceId) {
      ws.send(JSON.stringify({ error: "hello device mismatch" }));
      return;
    }
    if (hello.roomId !== pending.roomId) {
      ws.send(JSON.stringify({ error: "hello room mismatch" }));
      return;
    }

    const pinKey = `pin:${pending.deviceId}`;
    const pinned = (await this.state.storage.get<string>(pinKey)) ?? null;
    if (!verifyRelayHello(hello, pending.roomId, pinned)) {
      ws.send(JSON.stringify({ error: "hello invalid" }));
      try {
        ws.close(1008, "hello invalid");
      } catch {
        /* ignore */
      }
      this.pending.delete(ws);
      return;
    }

    if (!pinned) {
      await this.state.storage.put(pinKey, hello.ed25519PublicKey);
    }

    this.pending.delete(ws);

    // A reconnect replaces the previous admitted socket for this id.
    const stale = this.sessions.get(pending.deviceId);
    if (stale && stale !== ws) {
      try {
        stale.close(1000, "replaced");
      } catch {
        /* already closing */
      }
    }
    this.sessions.set(pending.deviceId, ws);

    try {
      ws.send(JSON.stringify({ ok: "hello" }));
    } catch {
      /* ignore */
    }

    // Flush short offline queue for this device.
    const queue = (await this.state.storage.get<QueuedFrame[]>("queue")) ?? [];
    const keep: QueuedFrame[] = [];
    const now = Date.now();
    for (const item of queue) {
      if (now - item.ts > RELAY_QUEUE_TTL_MS) continue;
      if (item.from === pending.deviceId) {
        keep.push(item);
        continue;
      }
      try {
        ws.send(item.raw);
      } catch {
        keep.push(item);
      }
    }
    await this.state.storage.put("queue", keep.slice(-RELAY_QUEUE_MAX));
  }

  webSocketClose(ws: WebSocket) {
    this.pending.delete(ws);
    for (const [id, sock] of this.sessions) {
      if (sock === ws) this.sessions.delete(id);
    }
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }
}

/// Ids come from device keys; keep them boring so a socket cannot smuggle a
/// colon (which would let it claim the other half of a pair room).
export function sanitizeId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.includes(":")) return "";
  return trimmed;
}

/// Which device is this socket? The explicit `self` parameter wins, but only
/// when it is one of the two pair halves — otherwise anyone holding the pair
/// string could sit in the room as a third (unremovable) listener. Old
/// clients that omit `self` get the legacy `A:B` guess.
export function resolveDeviceId(
  pairParam: string,
  selfParam: string | null,
  sessions: Map<string, WebSocket>,
): string {
  const parts = normalizePairId(pairParam).split(":").filter(Boolean);
  const self = selfParam ? sanitizeId(selfParam) : "";
  const validSelf =
    self.length > 0 &&
    (parts.length === 2 ? parts.includes(self) : self === pairParam);
  if (validSelf) return self;
  if (parts.length === 2) return guessSelfId(pairParam, sessions);
  return pairParam;
}

/**
 * Legacy fallback: derive a device id from the `A:B` pair param by taking the
 * half that is not already in the room. Mislabels a *reconnecting* device (if
 * A reconnects while B is absent, A takes B's slot), which is why the worker
 * prefers the explicit `self` parameter. Kept for old clients.
 */
export function guessSelfId(
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
