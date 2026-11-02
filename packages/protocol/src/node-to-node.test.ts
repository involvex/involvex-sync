/**
 * Two in-process peers exchange an encrypted share_url over a tiny
 * EventTarget bus — stands in for WebSocket without I/O.
 */
import { describe, expect, test } from "bun:test";
import { generateDeviceKeys } from "./crypto.js";
import {
  decryptFrame,
  encryptFrame,
  parseFrame,
  serializeFrame,
  shareUrlBody,
} from "./frame.js";
import type { WireFrame } from "./types.js";

class Bus {
  private readonly listeners = new Map<string, (raw: string) => void>();

  subscribe(id: string, fn: (raw: string) => void): void {
    this.listeners.set(id, fn);
  }

  send(to: string, raw: string): void {
    this.listeners.get(to)?.(raw);
  }
}

describe("node-to-node", () => {
  test("encrypted link opens on the other peer", () => {
    const phone = generateDeviceKeys();
    const desktop = generateDeviceKeys();
    const bus = new Bus();
    let opened: string | null = null;

    bus.subscribe("desktop", (raw) => {
      const frame = parseFrame(raw) as WireFrame;
      const result = decryptFrame(frame, desktop, {
        deviceId: phone.deviceId,
        ed25519PublicKey: phone.ed25519.publicKey,
        x25519PublicKey: phone.x25519.publicKey,
      });
      if (result.ok && result.body.payload.type === "share_url") {
        opened = result.body.payload.url;
      }
    });

    const body = shareUrlBody(
      phone.deviceId,
      "https://invent.kde.org/network/kdeconnect-android",
    );
    if (!body) throw new Error("invalid url");
    const frame = encryptFrame(body, phone, {
      deviceId: desktop.deviceId,
      ed25519PublicKey: desktop.ed25519.publicKey,
      x25519PublicKey: desktop.x25519.publicKey,
    });
    bus.send("desktop", serializeFrame(frame));

    expect(opened).toBe("https://invent.kde.org/network/kdeconnect-android");
  });
});
