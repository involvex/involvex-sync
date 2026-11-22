/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  decryptFrame,
  encryptFrame,
  generateDeviceKeys,
  hashText,
  serializeFrame,
  type DeviceKeys,
  type PeerPublicKeys,
} from "@involvex/protocol";

/** Stub RN / Expo before MobileSession pulls them in via identity/transport. */
void mock.module("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "android" },
}));
void mock.module("expo-constants", () => ({
  default: { expoConfig: { extra: { relayUrl: "wss://relay.test/ws" } } },
}));
void mock.module("expo-secure-store", () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
  deleteItemAsync: () => Promise.resolve(),
}));

type FakeSocket = {
  url: string;
  readyState: number;
  closed: boolean;
  sent: string[];
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

const sockets: FakeSocket[] = [];

function installFakeWebSocket(): void {
  sockets.length = 0;
  (globalThis as { WebSocket: unknown }).WebSocket = class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    url: string;
    readyState = FakeWebSocket.CONNECTING;
    closed = false;
    sent: string[] = [];
    onopen: FakeSocket["onopen"] = null;
    onclose: FakeSocket["onclose"] = null;
    onerror: FakeSocket["onerror"] = null;
    onmessage: FakeSocket["onmessage"] = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({});
      });
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
      this.readyState = FakeWebSocket.CLOSED;
    }
  };
}

function stored(keys: DeviceKeys, name: string) {
  return {
    deviceId: keys.deviceId,
    name,
    ed25519: keys.ed25519,
    x25519: keys.x25519,
  };
}

function peerKeys(keys: DeviceKeys): PeerPublicKeys {
  return {
    deviceId: keys.deviceId,
    ed25519PublicKey: keys.ed25519.publicKey,
    x25519PublicKey: keys.x25519.publicKey,
  };
}

function peer(keys: DeviceKeys, name: string, host: string) {
  return {
    deviceId: keys.deviceId,
    name,
    deviceType: "windows" as const,
    ed25519PublicKey: keys.ed25519.publicKey,
    x25519PublicKey: keys.x25519.publicKey,
    host,
    port: 17391,
  };
}

function lanTransport(p: { host?: string; port?: number }) {
  return {
    mode: "lan" as const,
    host: p.host ?? "127.0.0.1",
    port: p.port ?? 17391,
    relayUrl: "wss://relay.test/ws",
  };
}

async function loadSession() {
  const { MobileSession } = await import("./session");
  return MobileSession;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("MobileSession multi-host sockets", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });

  test("keeps one socket entry per paired host", async () => {
    const MobileSession = await loadSession();
    const logs: string[] = [];
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onStatus: () => {},
      onLog: (line) => logs.push(line),
    });
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers(
      [peer(a, "Desk", "192.168.1.10"), peer(b, "Laptop", "192.168.1.11")],
      lanTransport,
    );
    expect(session.peerIds).toEqual([a.deviceId, b.deviceId]);

    session.connectAll();
    await flush();

    expect(sockets).toHaveLength(2);
    expect(sockets.map((s) => s.url).sort()).toEqual([
      "ws://192.168.1.10:17391",
      "ws://192.168.1.11:17391",
    ]);
    expect(session.isPeerOpen(a.deviceId)).toBe(true);
    expect(session.isPeerOpen(b.deviceId)).toBe(true);
  });

  test("unpairing one host closes only that socket", async () => {
    const MobileSession = await loadSession();
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onStatus: () => {},
      onLog: () => {},
    });
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const peers = [
      peer(a, "Desk", "192.168.1.10"),
      peer(b, "Laptop", "192.168.1.11"),
    ];
    session.setPeers(peers, lanTransport);
    session.connectAll();
    await flush();
    expect(sockets).toHaveLength(2);
    const deskSocket = sockets[0];
    const laptopSocket = sockets[1];
    if (!deskSocket || !laptopSocket) throw new Error("expected two sockets");
    const nextPeer = peers[1];
    if (!nextPeer) throw new Error("expected laptop peer");

    session.setPeers([nextPeer], lanTransport);

    expect(deskSocket.closed).toBe(true);
    expect(laptopSocket.closed).toBe(false);
    expect(session.peerIds).toEqual([b.deviceId]);
    expect(session.isPeerOpen(b.deviceId)).toBe(true);
  });

  test("clearing the last peer closes its socket", async () => {
    const MobileSession = await loadSession();
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onStatus: () => {},
      onLog: () => {},
    });
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Desk", "192.168.1.10")], lanTransport);
    session.connectAll();
    await flush();
    expect(sockets).toHaveLength(1);
    const only = sockets[0];
    if (!only) throw new Error("expected one socket");

    session.setPeers([], lanTransport);

    expect(only.closed).toBe(true);
    expect(session.peerIds).toEqual([]);
  });

  test("drops frames addressed to another device", async () => {
    const MobileSession = await loadSession();
    const logs: string[] = [];
    const clips: Array<{ text: string; from: string }> = [];
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: (text, from) => {
        clips.push({ text, from });
      },
      onStatus: () => {},
      onLog: (line) => logs.push(line),
    });
    const desk = generateDeviceKeys();
    session.setPeers([peer(desk, "Desk", "192.168.1.10")], lanTransport);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: desk.deviceId,
        to: "someone-else",
        ts: Date.now(),
        payload: {
          type: "clipboard_update",
          text: "misfiled",
          hash: hashText("misfiled"),
        },
      },
      desk,
      peerKeys(phone),
    );
    await session.handleIncomingRaw(serializeFrame(frame), desk.deviceId);
    expect(clips).toEqual([]);
    expect(logs.some((l) => l.includes("addressed to someone-else"))).toBe(
      true,
    );
  });

  test("socket open invokes onPeerOnline for that host", async () => {
    const MobileSession = await loadSession();
    const online: string[] = [];
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onStatus: () => {},
      onLog: () => {},
      onPeerOnline: (deviceId) => {
        online.push(deviceId);
      },
    });
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers(
      [peer(a, "Desk", "192.168.1.10"), peer(b, "Laptop", "192.168.1.11")],
      lanTransport,
    );
    session.connectAll();
    await flush();

    expect(online.sort()).toEqual([a.deviceId, b.deviceId].sort());
  });

  test("decrypts by WireFrame.from, not by the active peer alone", async () => {
    const MobileSession = await loadSession();
    const clips: Array<{ text: string; from: string }> = [];
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: (text, from) => {
        clips.push({ text, from });
      },
      onStatus: () => {},
      onLog: () => {},
    });
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    session.setPeers(
      [peer(a, "Desk", "192.168.1.10"), peer(b, "Laptop", "192.168.1.11")],
      lanTransport,
    );
    session.setActivePeer(a.deviceId);

    const frame = encryptFrame(
      {
        v: 1,
        id: "abc",
        from: b.deviceId,
        ts: Date.now(),
        payload: {
          type: "clipboard_update",
          text: "from laptop",
          hash: hashText("from laptop"),
        },
      },
      b,
      peerKeys(phone),
    );
    await session.handleIncomingRaw(serializeFrame(frame), b.deviceId);
    expect(clips).toEqual([{ text: "from laptop", from: b.deviceId }]);
    expect(decryptFrame(frame, phone, peerKeys(b))).toMatchObject({
      ok: true,
    });
  });

  test("LAN close fails over to the relay room", async () => {
    const MobileSession = await loadSession();
    const logs: string[] = [];
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onStatus: () => {},
      onLog: (line) => logs.push(line),
    });
    const a = generateDeviceKeys();
    session.setPeers([peer(a, "Desk", "192.168.1.10")], lanTransport);
    session.connectAll();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://192.168.1.10:17391");
    expect(session.peerPath(a.deviceId)).toBe("lan");

    const lan = sockets[0];
    if (!lan) throw new Error("expected lan socket");
    lan.readyState = 3;
    lan.onclose?.({});
    await flush();
    // Backoff override is 500ms — advance by calling open via timer flush.
    await new Promise((r) => setTimeout(r, 600));
    await flush();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const relay = sockets[sockets.length - 1];
    expect(relay?.url).toContain("wss://relay.test/ws");
    expect(relay?.url).toContain(`self=${encodeURIComponent(phone.deviceId)}`);
    expect(logs.some((l) => l.includes("failing over to relay"))).toBe(true);
    session.disconnect();
  });

  test("connect({ pairing: true }) sends a pair request on open", async () => {
    const MobileSession = await loadSession();
    const logs: string[] = [];
    const phone = generateDeviceKeys();
    const session = new MobileSession(stored(phone, "Phone"), {
      onShareUrl: () => {},
      onClipboard: () => {},
      onStatus: () => {},
      onLog: (line) => logs.push(line),
    });

    session.connect(lanTransport({ host: "192.168.1.10" }), { pairing: true });
    await flush();

    expect(sockets).toHaveLength(1);
    const ws = sockets[0];
    if (!ws) throw new Error("expected pairing socket");
    expect(ws.sent).toHaveLength(1);
    const raw = ws.sent[0];
    if (!raw) throw new Error("expected pair request payload");
    const parsed = JSON.parse(raw) as {
      kind?: string;
      device?: { deviceId?: string };
    };
    expect(parsed.kind).toBe("involvex-sync-pair-request");
    expect(parsed.device?.deviceId).toBe(phone.deviceId);
    expect(logs).toContain("pair request sent");
  });
});
