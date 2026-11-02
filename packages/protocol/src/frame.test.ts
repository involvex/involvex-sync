import { describe, expect, test } from "bun:test";
import { generateDeviceKeys } from "./crypto";
import {
  decryptFrame,
  encryptFrame,
  parseFrame,
  serializeFrame,
  shareUrlBody,
} from "./frame";
import {
  buildPairAccept,
  buildPairReject,
  buildPairRequest,
  buildPairingPayload,
  pairingQrText,
  parsePairHandshake,
  parsePairingQr,
} from "./pairing";

describe("frame encrypt/decrypt", () => {
  test("phone → desktop share_url roundtrip", () => {
    const phone = generateDeviceKeys();
    const desktop = generateDeviceKeys();

    const body = shareUrlBody(phone.deviceId, "https://github.com/involvex");
    expect(body).not.toBeNull();
    if (!body) return;

    const peerDesktop = {
      deviceId: desktop.deviceId,
      ed25519PublicKey: desktop.ed25519.publicKey,
      x25519PublicKey: desktop.x25519.publicKey,
    };
    const peerPhone = {
      deviceId: phone.deviceId,
      ed25519PublicKey: phone.ed25519.publicKey,
      x25519PublicKey: phone.x25519.publicKey,
    };

    const frame = encryptFrame(body, phone, peerDesktop);
    const wire = serializeFrame(frame);
    const parsed = parseFrame(wire);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    const result = decryptFrame(parsed, desktop, peerPhone);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.payload.type).toBe("share_url");
    if (result.body.payload.type === "share_url") {
      expect(result.body.payload.url).toBe("https://github.com/involvex");
    }
  });

  test("rejects bad signature", () => {
    const phone = generateDeviceKeys();
    const desktop = generateDeviceKeys();
    const body = shareUrlBody(phone.deviceId, "https://example.com");
    if (!body) throw new Error("body");
    const frame = encryptFrame(body, phone, {
      deviceId: desktop.deviceId,
      ed25519PublicKey: desktop.ed25519.publicKey,
      x25519PublicKey: desktop.x25519.publicKey,
    });
    frame.signature = "00".repeat(64);
    const result = decryptFrame(frame, desktop, {
      deviceId: phone.deviceId,
      ed25519PublicKey: phone.ed25519.publicKey,
      x25519PublicKey: phone.x25519.publicKey,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects unsafe url in shareUrlBody", () => {
    const phone = generateDeviceKeys();
    expect(shareUrlBody(phone.deviceId, "javascript:alert(1)")).toBeNull();
  });
});

describe("pairing qr", () => {
  test("roundtrip", () => {
    const keys = generateDeviceKeys();
    const payload = buildPairingPayload(
      keys,
      "Pixel",
      "android",
      "192.168.1.10",
      17391,
    );
    const text = pairingQrText(payload);
    const parsed = parsePairingQr(text);
    expect(parsed?.device.deviceId).toBe(keys.deviceId);
    expect(parsed?.host).toBe("192.168.1.10");
  });
});

describe("pair handshake", () => {
  test("request / accept / reject parse", () => {
    const keys = generateDeviceKeys();
    const req = buildPairRequest(keys, "Pixel", "android");
    expect(parsePairHandshake(JSON.stringify(req))?.kind).toBe(
      "involvex-sync-pair-request",
    );
    const acc = buildPairAccept(keys, "PC", "windows", "192.168.1.2", 17391);
    const parsedAcc = parsePairHandshake(JSON.stringify(acc));
    expect(parsedAcc?.kind).toBe("involvex-sync-pair-accept");
    if (parsedAcc?.kind === "involvex-sync-pair-accept") {
      expect(parsedAcc.host).toBe("192.168.1.2");
    }
    const rej = buildPairReject(keys.deviceId, "nope");
    expect(parsePairHandshake(JSON.stringify(rej))?.kind).toBe(
      "involvex-sync-pair-reject",
    );
  });
});
