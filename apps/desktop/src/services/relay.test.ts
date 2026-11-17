/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateDeviceKeys } from "@involvex/protocol";
import { RelayClient } from "./relay";

type FakeSocket = {
  url: string;
  readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close: () => void;
};

const sockets: FakeSocket[] = [];
let RealWebSocket: typeof WebSocket;

function installFakeWebSocket(): void {
  sockets.length = 0;
  RealWebSocket = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    url: string;
    readyState = FakeWebSocket.CONNECTING;
    onopen: FakeSocket["onopen"] = null;
    onclose: FakeSocket["onclose"] = null;
    onerror: FakeSocket["onerror"] = null;
    onmessage: FakeSocket["onmessage"] = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  };
}

describe("RelayClient reconnect", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = RealWebSocket;
  });

  test("schedules reconnect after close while still wanted", () => {
    const statuses: string[] = [];
    const local = generateDeviceKeys();
    const peer = generateDeviceKeys();
    const client = new RelayClient(local, peer.deviceId, {
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
    });

    client.connect();
    expect(sockets).toHaveLength(1);
    const first = sockets[0];
    if (!first) throw new Error("expected socket");
    first.readyState = 1;
    first.onopen?.({});
    expect(statuses.some((s) => s === "relay connected")).toBe(true);

    first.readyState = 3;
    first.onclose?.({});
    expect(statuses.some((s) => s.startsWith("relay reconnect in"))).toBe(true);

    client.disconnect();
    expect(sockets).toHaveLength(1);
  });

  test("disconnect cancels further reconnects", () => {
    const statuses: string[] = [];
    const local = generateDeviceKeys();
    const client = new RelayClient(local, undefined, {
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
    });
    client.connect();
    const first = sockets[0];
    if (!first) throw new Error("expected socket");
    client.disconnect();
    first.onclose?.({});
    expect(statuses.some((s) => s.startsWith("relay reconnect"))).toBe(false);
  });
});
