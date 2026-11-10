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
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

type FakeSocket = {
  url: string;
  readyState: number;
  closed: boolean;
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
    onopen: FakeSocket["onopen"] = null;
    onclose: FakeSocket["onclose"] = null;
    onerror: FakeSocket["onerror"] = null;
    onmessage: FakeSocket["onmessage"] = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as FakeSocket);
      queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({});
      });
    }
    send(_data: string) {}
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
    const deskSocket = sockets[0]!;
    const laptopSocket = sockets[1]!;

    session.setPeers([peers[1]!], lanTransport);

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

    session.setPeers([], lanTransport);

    expect(sockets[0]!.closed).toBe(true);
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
});
