import { describe, expect, test } from "bun:test";
import {
  FILE_CHUNK_BYTES,
  encryptFrame,
  fileChunkBody,
  generateDeviceKeys,
  serializeFrame,
  toBase64,
} from "./index";
import {
  RELAY_LIVE_MAX_CHARS,
  RELAY_QUEUE_MAX_CHARS,
  normalizePairId,
} from "./relayLimits";

describe("relay limits", () => {
  test("a sealed max-size file_chunk fits the live forward cap", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const chunk = new Uint8Array(FILE_CHUNK_BYTES);
    crypto.getRandomValues(chunk);
    const body = fileChunkBody(
      a.deviceId,
      {
        transferId: "abcd1234",
        index: 0,
        dataBase64: toBase64(chunk),
      },
      b.deviceId,
    );
    const raw = serializeFrame(
      encryptFrame(body, a, {
        deviceId: b.deviceId,
        ed25519PublicKey: b.ed25519.publicKey,
        x25519PublicKey: b.x25519.publicKey,
      }),
    );
    expect(raw.length).toBeLessThanOrEqual(RELAY_LIVE_MAX_CHARS);
    expect(raw.length).toBeGreaterThan(RELAY_QUEUE_MAX_CHARS);
  });

  test("normalizePairId sorts halves", () => {
    expect(normalizePairId("b:a")).toBe("a:b");
  });
});
