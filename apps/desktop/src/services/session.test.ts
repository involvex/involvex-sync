import { describe, expect, mock, test, beforeEach } from "bun:test";
import {
  decryptFrame,
  encryptFrame,
  generateDeviceKeys,
  hashText,
  parseFrame,
  serializeFrame,
  type DeviceKeys,
  type PeerPublicKeys,
} from "@involvex/protocol";

import { SyncSession } from "./session";
import type { StoredPeer, StoredDeviceKeys } from "./identity";

/** Captured Tauri invoke calls for the send tests. */
const sent: Array<{ cmd: string; connId?: number; message: string }> = [];
/** Frames handed to the relay fallback. */
const relaySent: string[] = [];
/** When true, `ws_send_to` fails as if the socket died. */
let failSendTo = false;

// session.ts imports `invoke` from @tauri-apps/api/core, which needs a browser
// global. Mock the module so send tests can inspect what would hit the socket.
void mock.module("@tauri-apps/api/core", () => ({
  invoke: (
    cmd: string,
    args: { message?: string; connId?: number } | undefined,
  ) => {
    if (cmd === "ws_send_to") {
      if (failSendTo) {
        return Promise.reject(new Error(`connection ${args?.connId} is gone`));
      }
      if (args?.message) {
        sent.push({ cmd, connId: args.connId, message: args.message });
      }
      return Promise.resolve(null);
    }
    if (cmd === "ws_send" && args?.message) {
      sent.push({ cmd, message: args.message });
    }
    return Promise.resolve(null);
  },
}));

beforeEach(() => {
  sent.length = 0;
  relaySent.length = 0;
  failSendTo = false;
});

/** DeviceKeys already uses hex strings, so it maps 1:1 onto the stored shape. */
function stored(keys: DeviceKeys, name: string): StoredDeviceKeys {
  return {
    deviceId: keys.deviceId,
    name,
    ed25519: keys.ed25519,
    x25519: keys.x25519,
  };
}

/** A DeviceKeys as seen by the wire protocol (hex public keys). */
function peerKeys(keys: DeviceKeys): PeerPublicKeys {
  return {
    deviceId: keys.deviceId,
    ed25519PublicKey: keys.ed25519.publicKey,
    x25519PublicKey: keys.x25519.publicKey,
  };
}

function peer(keys: DeviceKeys, name: string): StoredPeer {
  return {
    deviceId: keys.deviceId,
    name,
    deviceType: "android",
    ed25519PublicKey: keys.ed25519.publicKey,
    x25519PublicKey: keys.x25519.publicKey,
  };
}

function pingPayload(ts = Date.now()) {
  return { type: "ping" as const, ts };
}

function clipPayload(text: string) {
  return { type: "clipboard_update" as const, text, hash: hashText(text) };
}

/** Minimal capture of what the session was asked to do. */
function harness() {
  const logs: string[] = [];
  const clips: Array<{ text: string; from: string }> = [];
  const desk = generateDeviceKeys();
  const session = new SyncSession(stored(desk, "Desk"), {
    onShareUrl: () => {},
    onClipboard: (text, from) => {
      clips.push({ text, from });
    },
    onLog: (line) => logs.push(line),
  });
  return { session, logs, clips, desk };
}

describe("SyncSession peer routing", () => {
  test("seals outbound frames for the active peer only", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);
    // A identifies itself on connect, so the send can be socket-targeted.
    await session.handleIncomingRaw(
      serializeFrame(
        encryptFrame(
          {
            v: 1,
            id: "a1",
            from: a.deviceId,
            ts: Date.now(),
            payload: pingPayload(),
          },
          a,
          peerKeys(desk),
        ),
      ),
      3,
    );

    await session.sendClipboard("hello");

    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBe("ws_send_to");
    expect(sent[0].connId).toBe(3);
    const frame = parseFrame(sent[0].message);
    expect(frame?.from).toBe(desk.deviceId);

    // Opens with the active peer's keys…
    expect(decryptFrame(frame!, a, peerKeys(desk))).toMatchObject({ ok: true });
    // …and fails with the other paired device's keys.
    expect(decryptFrame(frame!, b, peerKeys(desk)).ok).toBe(false);
  });

  test("switching the active peer re-targets outbound frames", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);
    // Both devices identify themselves as soon as they connect.
    await session.handleIncomingRaw(
      serializeFrame(
        encryptFrame(
          {
            v: 1,
            id: "a1",
            from: a.deviceId,
            ts: Date.now(),
            payload: pingPayload(),
          },
          a,
          peerKeys(desk),
        ),
      ),
      3,
    );
    await session.handleIncomingRaw(
      serializeFrame(
        encryptFrame(
          {
            v: 1,
            id: "b1",
            from: b.deviceId,
            ts: Date.now(),
            payload: pingPayload(),
          },
          b,
          peerKeys(desk),
        ),
      ),
      8,
    );

    await session.sendClipboard("one");
    session.setActivePeer(b.deviceId);
    await session.sendClipboard("two");

    expect(sent).toHaveLength(2);
    expect(sent[0].cmd).toBe("ws_send_to");
    expect(sent[0].connId).toBe(3);
    expect(sent[1].cmd).toBe("ws_send_to");
    expect(sent[1].connId).toBe(8);
    const second = parseFrame(sent[1].message);
    expect(decryptFrame(second!, b, peerKeys(desk))).toMatchObject({
      ok: true,
    });
    expect(decryptFrame(second!, a, peerKeys(desk)).ok).toBe(false);
  });

  test("sends to the socket the active peer was heard on", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(b.deviceId);

    // B's frames arrive on conn 9 — after A connected on conn 3, so
    // "latest wins" would have picked the wrong socket.
    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: b.deviceId,
        ts: Date.now(),
        payload: clipPayload("hi"),
      },
      b,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 9);
    expect(session.connIdFor(b.deviceId)).toBe(9);

    await session.sendClipboard("to laptop");
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBe("ws_send_to");
    expect(sent[0].connId).toBe(9);
  });

  test("falls back to ws_send when the socket mapping is unknown", async () => {
    const { session } = harness();
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Phone")]);
    session.setActivePeer(a.deviceId);

    // No inbound frame yet, so no conn id is known.
    await session.sendClipboard("hello");
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBe("ws_send");
  });

  test("forgetConn drops the mapping so the next send uses ws_send", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Phone")]);
    session.setActivePeer(a.deviceId);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: a.deviceId,
        ts: Date.now(),
        payload: clipPayload("hi"),
      },
      a,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 4);
    expect(session.connIdFor(a.deviceId)).toBe(4);

    session.forgetConn(4);
    expect(session.connIdFor(a.deviceId)).toBeUndefined();
    await session.sendClipboard("again");
    expect(sent.at(-1)?.cmd).toBe("ws_send");
  });

  test("a dead socket falls back to the relay instead of another device", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);
    session.setRelaySender((raw) => relaySent.push(raw));

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: a.deviceId,
        ts: Date.now(),
        payload: clipPayload("hi"),
      },
      a,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 6);

    failSendTo = true;
    await session.sendClipboard("via relay");

    expect(relaySent).toHaveLength(1);
    // The mapping is cleared so we do not keep hitting the dead socket.
    expect(session.connIdFor(a.deviceId)).toBeUndefined();
    // Crucially, the frame never went to B's socket.
    expect(sent).toEqual([]);
  });

  test("relay fallback covers share, find-phone and notes — not only clipboard", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);
    session.setRelaySender((raw) => relaySent.push(raw));

    // Map A to a socket, then kill it so every send must use the relay.
    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: a.deviceId,
        ts: Date.now(),
        payload: pingPayload(),
      },
      a,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 6);
    failSendTo = true;

    await session.sendShareUrl("https://example.com/shared");
    await session.sendFindPhone(5_000);
    await session.sendNoteUpsert({
      id: "n1",
      title: "t",
      body: "b",
      updatedAt: 1,
    });

    // share + find (active) + note sealed once per paired peer (A and B).
    expect(relaySent).toHaveLength(4);
    expect(sent).toEqual([]);
    const expectPeer = (raw: string | undefined, keys: typeof a) => {
      expect(raw).toBeDefined();
      const sealed = parseFrame(raw as string);
      expect(sealed).not.toBeNull();
      expect(decryptFrame(sealed!, keys, peerKeys(desk))).toMatchObject({
        ok: true,
      });
    };
    expectPeer(relaySent[0], a);
    expectPeer(relaySent[1], a);
    expectPeer(relaySent[2], a);
    expectPeer(relaySent[3], b);
  });

  test("never uses ws_send when another device's socket is ambiguous", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    // A is selected but has never been heard on a socket; B has.
    session.setActivePeer(a.deviceId);
    session.setRelaySender((raw) => relaySent.push(raw));

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: b.deviceId,
        ts: Date.now(),
        payload: clipPayload("hi"),
      },
      b,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 8);

    await session.sendClipboard("to phone");
    // Not B's socket, and not the ambiguous ws_send.
    expect(sent).toEqual([]);
    expect(relaySent).toHaveLength(1);
  });

  test("rejects rather than guessing an ambiguous LAN target", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: b.deviceId,
        ts: Date.now(),
        payload: clipPayload("hi"),
      },
      b,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 8);

    await expect(session.sendClipboard("to phone")).rejects.toThrow(
      "active device socket unknown",
    );
  });

  test("removePeer drops the socket mapping", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Phone")]);
    session.setActivePeer(a.deviceId);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: a.deviceId,
        ts: Date.now(),
        payload: clipPayload("hi"),
      },
      a,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame), 2);
    expect(session.connIdFor(a.deviceId)).toBe(2);

    session.removePeer(a.deviceId);
    expect(session.connIdFor(a.deviceId)).toBeUndefined();
    expect(session.peerIds).toEqual([]);
  });

  test("pair requests remember the socket they arrived on", async () => {
    const { session } = harness();
    const a = generateDeviceKeys();
    // Pairing payloads are cleartext handshakes; the parser accepts this
    // minimal shape.
    const handshake = JSON.stringify({
      v: 1,
      kind: "involvex-sync-pair-request",
      device: {
        deviceId: a.deviceId,
        name: "Phone",
        type: "android",
        ed25519PublicKey: a.ed25519.publicKey,
        x25519PublicKey: a.x25519.publicKey,
      },
    });
    await session.handleIncomingRaw(handshake, 11);
    expect(session.connIdFor(a.deviceId)).toBe(11);
  });

  test("decrypts inbound frames from any known peer, not just the active one", async () => {
    const { session, clips, logs, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: b.deviceId,
        ts: Date.now(),
        payload: clipPayload("from laptop"),
      },
      b,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame));
    expect(clips).toEqual([{ text: "from laptop", from: b.deviceId }]);
    expect(logs.filter((l) => l.startsWith("drop:"))).toEqual([]);
  });

  test("drops frames addressed to another device", async () => {
    const { session, clips, logs, desk } = harness();
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Phone")]);
    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: a.deviceId,
        // Not this desktop's id.
        to: "someone-else",
        ts: Date.now(),
        payload: clipPayload("misfiled"),
      },
      a,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame));
    expect(clips).toEqual([]);
    expect(logs.some((l) => l.includes("addressed to someone-else"))).toBe(
      true,
    );
  });

  test("drops frames from an unknown sender", async () => {
    const { session, clips, logs, desk } = harness();
    const known = generateDeviceKeys();
    const stranger = generateDeviceKeys();
    session.setPeers([peer(known, "Phone")]);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: stranger.deviceId,
        ts: Date.now(),
        payload: clipPayload("who?"),
      },
      stranger,
      peerKeys(desk),
    );
    await session.handleIncomingRaw(serializeFrame(frame));
    expect(clips).toEqual([]);
    expect(logs.some((l) => l.includes("unknown sender"))).toBe(true);
  });

  test("removing the active peer falls back to the remaining one", () => {
    const { session } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    expect(session.activeDeviceId).toBe(a.deviceId);

    session.removePeer(a.deviceId);
    expect(session.activeDeviceId).toBe(b.deviceId);
    expect(session.peerIds).toEqual([b.deviceId]);

    session.clearPeer();
    expect(session.peerIds).toEqual([]);
    expect(session.activeDeviceId).toBeNull();
  });

  test("re-pairing an existing device keeps its position", () => {
    const { session } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);

    // addPeer with active=false must not steal the active slot.
    session.addPeer(peer(a, "Phone renamed"), false);
    expect(session.peerIds).toEqual([a.deviceId, b.deviceId]);
    expect(session.activeDeviceId).toBe(a.deviceId);

    // …and an explicit active switch does.
    session.addPeer(peer(b, "Laptop"), true);
    expect(session.activeDeviceId).toBe(b.deviceId);
  });

  test("notes/secrets/vault fan out to every connected peer", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);

    for (const [keys, connId] of [
      [a, 3],
      [b, 4],
    ] as const) {
      await session.handleIncomingRaw(
        serializeFrame(
          encryptFrame(
            {
              v: 1,
              id: `ping-${connId}`,
              from: keys.deviceId,
              ts: Date.now(),
              payload: pingPayload(),
            },
            keys,
            peerKeys(desk),
          ),
        ),
        connId,
      );
    }

    await session.sendNoteUpsert({
      id: "n1",
      title: "t",
      body: "b",
      updatedAt: 1,
    });
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.connId).sort()).toEqual([3, 4]);

    for (const entry of sent) {
      const frame = parseFrame(entry.message);
      expect(frame).not.toBeNull();
      if (!frame) continue;
      const target = entry.connId === 3 ? a : b;
      const other = entry.connId === 3 ? b : a;
      const opened = decryptFrame(frame, target, peerKeys(desk));
      expect(opened).toMatchObject({
        ok: true,
        body: {
          to: target.deviceId,
          payload: { type: "note_upsert", id: "n1" },
        },
      });
      // Wrong peer cannot open the other's sealed copy.
      expect(decryptFrame(frame, other, peerKeys(desk)).ok).toBe(false);
    }

    sent.length = 0;
    await session.sendVaultKeyShare("a".repeat(64));
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.connId).sort()).toEqual([3, 4]);

    sent.length = 0;
    await session.sendSecretUpsert({
      id: "s1",
      updatedAt: 2,
      ciphertext: "c",
      nonce: "n",
      meta: { label: "x", kind: "password" },
    });
    expect(sent).toHaveLength(2);

    sent.length = 0;
    await session.sendNoteDelete({ id: "n1", updatedAt: 3 });
    await session.sendSecretDelete({ id: "s1", updatedAt: 4 });
    expect(sent).toHaveLength(4);
  });

  test("onPeerOnline fires once when a paired device's socket is mapped", async () => {
    const online: string[] = [];
    const desk = generateDeviceKeys();
    const session = new SyncSession(stored(desk, "Desk"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onLog: () => {},
      onPeerOnline: (deviceId) => {
        online.push(deviceId);
      },
    });
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Phone")]);

    const ping = (id: string, connId: number) =>
      session.handleIncomingRaw(
        serializeFrame(
          encryptFrame(
            {
              v: 1,
              id,
              from: a.deviceId,
              ts: Date.now(),
              payload: pingPayload(),
            },
            a,
            peerKeys(desk),
          ),
        ),
        connId,
      );

    await ping("p1", 5);
    expect(online).toEqual([a.deviceId]);

    // Same socket again: no second fire.
    await ping("p2", 5);
    expect(online).toEqual([a.deviceId]);

    // Remap to a new conn id: fires again.
    await ping("p3", 9);
    expect(online).toEqual([a.deviceId, a.deviceId]);
  });

  test("targeted note upsert reaches only the named conn id", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);

    for (const [keys, connId] of [
      [a, 3],
      [b, 4],
    ] as const) {
      await session.handleIncomingRaw(
        serializeFrame(
          encryptFrame(
            {
              v: 1,
              id: `ping-${connId}`,
              from: keys.deviceId,
              ts: Date.now(),
              payload: pingPayload(),
            },
            keys,
            peerKeys(desk),
          ),
        ),
        connId,
      );
    }

    sent.length = 0;
    await session.sendNoteUpsertTo(b.deviceId, {
      id: "n-only-b",
      title: "for b",
      body: "x",
      updatedAt: 1,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].connId).toBe(4);
    const frame = parseFrame(sent[0].message);
    expect(frame).not.toBeNull();
    if (!frame) return;
    const opened = decryptFrame(frame, b, peerKeys(desk));
    expect(opened).toMatchObject({
      ok: true,
      body: {
        to: b.deviceId,
        payload: { type: "note_upsert", id: "n-only-b" },
      },
    });
    expect(decryptFrame(frame, a, peerKeys(desk)).ok).toBe(false);
  });

  test("shared fan-out skips offline peers and still reaches live ones", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);
    // Only A has a live socket mapping.
    await session.handleIncomingRaw(
      serializeFrame(
        encryptFrame(
          {
            v: 1,
            id: "a1",
            from: a.deviceId,
            ts: Date.now(),
            payload: pingPayload(),
          },
          a,
          peerKeys(desk),
        ),
      ),
      9,
    );

    await session.sendNoteUpsert({
      id: "n2",
      title: "only a",
      body: "x",
      updatedAt: 1,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].connId).toBe(9);
    const frame = parseFrame(sent[0].message);
    expect(frame).not.toBeNull();
    if (!frame) return;
    const opened = decryptFrame(frame, a, peerKeys(desk));
    expect(opened).toMatchObject({
      ok: true,
      body: { to: a.deviceId, payload: { type: "note_upsert" } },
    });
  });

  test("shared fan-out uses each peer's relay room when LAN is down", async () => {
    const { session, desk } = harness();
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers([peer(a, "Phone"), peer(b, "Laptop")]);
    session.setActivePeer(a.deviceId);
    const byPeer = new Map<string, string[]>();
    session.setRelaySenders(
      new Map([
        [
          a.deviceId,
          (raw) => {
            const list = byPeer.get(a.deviceId) ?? [];
            list.push(raw);
            byPeer.set(a.deviceId, list);
          },
        ],
        [
          b.deviceId,
          (raw) => {
            const list = byPeer.get(b.deviceId) ?? [];
            list.push(raw);
            byPeer.set(b.deviceId, list);
          },
        ],
      ]),
    );

    await session.sendNoteUpsert({
      id: "n3",
      title: "relay",
      body: "both",
      updatedAt: 1,
    });

    expect(sent).toEqual([]);
    const aFrames = byPeer.get(a.deviceId) ?? [];
    const bFrames = byPeer.get(b.deviceId) ?? [];
    expect(aFrames).toHaveLength(1);
    expect(bFrames).toHaveLength(1);
    for (const [peerKeysLocal, raw] of [
      [a, aFrames[0]] as const,
      [b, bFrames[0]] as const,
    ]) {
      expect(raw).toBeDefined();
      const frame = parseFrame(raw ?? "");
      expect(frame).not.toBeNull();
      if (!frame) continue;
      expect(decryptFrame(frame, peerKeysLocal, peerKeys(desk))).toMatchObject({
        ok: true,
        body: {
          to: peerKeysLocal.deviceId,
          payload: { type: "note_upsert" },
        },
      });
    }
  });

  test("caps concurrent file assemblers at 3 and drops the oldest", async () => {
    const { session, desk, logs } = harness();
    const phone = generateDeviceKeys();
    session.setPeers([peer(phone, "Phone")]);
    session.setActivePeer(phone.deviceId);

    const offer = (transferId: string) =>
      serializeFrame(
        encryptFrame(
          {
            v: 1,
            id: transferId,
            from: phone.deviceId,
            ts: Date.now(),
            payload: {
              type: "file_offer" as const,
              transferId,
              name: `${transferId}.bin`,
              mimeType: "application/octet-stream",
              size: 64,
              totalChunks: 1,
            },
          },
          phone,
          peerKeys(desk),
        ),
      );

    await session.handleIncomingRaw(offer("t1"), 1);
    await session.handleIncomingRaw(offer("t2"), 1);
    await session.handleIncomingRaw(offer("t3"), 1);
    expect(session.assemblerCount()).toBe(3);

    await session.handleIncomingRaw(offer("t4"), 1);
    expect(session.assemblerCount()).toBe(3);
    expect(logs.some((l) => l.includes("drop oldest transfer t1"))).toBe(true);

    // Replacing the same transferId does not grow past the cap.
    await session.handleIncomingRaw(offer("t4"), 1);
    expect(session.assemblerCount()).toBe(3);
  });

  test("rejects oversized single-shot file_transfer before decode", async () => {
    const logs: string[] = [];
    const files: string[] = [];
    const desk = generateDeviceKeys();
    const session = new SyncSession(stored(desk, "Desk"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onFileTransfer: (file) => {
        files.push(file.name);
      },
      onLog: (line) => logs.push(line),
    });
    const phone = generateDeviceKeys();
    session.setPeers([peer(phone, "Phone")]);
    session.setActivePeer(phone.deviceId);

    await session.handleIncomingRaw(
      serializeFrame(
        encryptFrame(
          {
            v: 1,
            id: "big",
            from: phone.deviceId,
            ts: Date.now(),
            payload: {
              type: "file_transfer" as const,
              name: "huge.bin",
              mimeType: "application/octet-stream",
              size: 10 * 1024 * 1024,
              dataBase64: "AAAA",
            },
          },
          phone,
          peerKeys(desk),
        ),
      ),
      1,
    );
    expect(files).toHaveLength(0);
    expect(logs.some((l) => l.includes("drop: file_transfer size"))).toBe(true);
  });
});

describe("wire frame envelope", () => {
  test("carries the sender id in cleartext", () => {
    const keys = generateDeviceKeys();
    const other = generateDeviceKeys();
    const frame = encryptFrame(
      {
        v: 1,
        id: "i",
        from: keys.deviceId,
        to: other.deviceId,
        ts: 1,
        payload: pingPayload(),
      },
      keys,
      peerKeys(other),
    );
    expect(frame.from).toBe(keys.deviceId);
    const parsed = parseFrame(serializeFrame(frame));
    expect(parsed?.from).toBe(keys.deviceId);
  });
});
