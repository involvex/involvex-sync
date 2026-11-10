import { describe, expect, mock, test, beforeEach } from "bun:test";
import {
  decryptFrame,
  encryptFrame,
  generateDeviceKeys,
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

/** Minimal capture of what the session was asked to do. */
function harness() {
  const logs: string[] = [];
  const clips: Array<{ text: string; from: string }> = [];
  const desk = generateDeviceKeys();
  const session = new SyncSession(stored(desk, "Desk"), {
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
            payload: { type: "ping" },
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
            payload: { type: "ping" },
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
            payload: { type: "ping" },
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
        payload: { type: "clipboard_update", text: "hi" },
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
        payload: { type: "clipboard_update", text: "hi" },
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
        payload: { type: "clipboard_update", text: "hi" },
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
        payload: { type: "clipboard_update", text: "hi" },
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
        payload: { type: "clipboard_update", text: "hi" },
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
        payload: { type: "clipboard_update", text: "hi" },
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
        payload: { type: "clipboard_update", text: "from laptop" },
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
        payload: { type: "clipboard_update", text: "misfiled" },
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
        payload: { type: "clipboard_update", text: "who?" },
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
        payload: { type: "ping" },
      },
      keys,
      peerKeys(other),
    );
    expect(frame.from).toBe(keys.deviceId);
    const parsed = parseFrame(serializeFrame(frame));
    expect(parsed?.from).toBe(keys.deviceId);
  });
});
