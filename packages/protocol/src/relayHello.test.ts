import { describe, expect, test } from "bun:test";
import { generateDeviceKeys } from "./crypto";
import { normalizePairId } from "./relayLimits";
import {
  buildRelayHello,
  parseRelayError,
  parseRelayHello,
  verifyRelayHello,
} from "./relayHello";

describe("relay hello", () => {
  test("build + verify round-trip", () => {
    const local = generateDeviceKeys();
    const peer = generateDeviceKeys();
    const hello = buildRelayHello(local, peer.deviceId);
    const roomId = normalizePairId(`${local.deviceId}:${peer.deviceId}`);
    expect(hello.roomId).toBe(roomId);
    expect(verifyRelayHello(hello, roomId)).toBe(true);
    expect(verifyRelayHello(hello, roomId, local.ed25519.publicKey)).toBe(true);
  });

  test("rejects a hello signed by a different key", () => {
    const local = generateDeviceKeys();
    const peer = generateDeviceKeys();
    const other = generateDeviceKeys();
    const hello = buildRelayHello(local, peer.deviceId);
    const roomId = hello.roomId;
    expect(verifyRelayHello(hello, roomId, other.ed25519.publicKey)).toBe(
      false,
    );
  });

  test("rejects tampered room or device id", () => {
    const local = generateDeviceKeys();
    const peer = generateDeviceKeys();
    const hello = buildRelayHello(local, peer.deviceId);
    expect(verifyRelayHello({ ...hello, roomId: "x:y" }, hello.roomId)).toBe(
      false,
    );
    expect(
      verifyRelayHello({ ...hello, deviceId: peer.deviceId }, hello.roomId),
    ).toBe(false);
  });

  test("parseRelayHello accepts only the hello kind", () => {
    const local = generateDeviceKeys();
    const peer = generateDeviceKeys();
    const hello = buildRelayHello(local, peer.deviceId);
    expect(parseRelayHello(JSON.stringify(hello))).toEqual(hello);
    expect(parseRelayHello(JSON.stringify({ error: "frame too large" }))).toBe(
      null,
    );
  });

  test("parseRelayError only matches pure error envelopes", () => {
    expect(
      parseRelayError(JSON.stringify({ error: "frame too large" })),
    ).toEqual({ error: "frame too large" });
    expect(
      parseRelayError(JSON.stringify({ error: "x", from: "a" })),
    ).toBeNull();
    expect(parseRelayError("not-json")).toBeNull();
  });
});
