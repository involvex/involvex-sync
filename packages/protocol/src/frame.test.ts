import { describe, expect, test } from "bun:test";
import { generateDeviceKeys } from "./crypto";
import {
  clipboardHistoryDeleteBody,
  clipboardHistoryUpsertBody,
  decryptFrame,
  encryptFrame,
  fileOfferBody,
  fileTransferBody,
  parseFrame,
  serializeFrame,
  shareUrlBody,
} from "./frame";
import { MAX_CLIPBOARD_HISTORY_TEXT_CHARS } from "./types";
import { ChunkAssembler } from "./transfer";
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

  test("file_transfer relativePath roundtrips; omit stays omit", () => {
    const phone = generateDeviceKeys();
    const desktop = generateDeviceKeys();
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

    const withPath = fileTransferBody(phone.deviceId, {
      name: "a.pdf",
      mimeType: "application/pdf",
      dataBase64: "QQ==",
      size: 1,
      relativePath: "notes/2026/a.pdf",
    });
    const frame = encryptFrame(withPath, phone, peerDesktop);
    const opened = decryptFrame(
      parseFrame(serializeFrame(frame))!,
      desktop,
      peerPhone,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.body.payload.type).toBe("file_transfer");
    if (opened.body.payload.type === "file_transfer") {
      expect(opened.body.payload.relativePath).toBe("notes/2026/a.pdf");
      expect(opened.body.payload.name).toBe("a.pdf");
    }

    const bare = fileTransferBody(phone.deviceId, {
      name: "b.pdf",
      mimeType: "application/pdf",
      dataBase64: "Qg==",
      size: 1,
    });
    expect(
      bare.payload.type === "file_transfer" &&
        bare.payload.relativePath === undefined,
    ).toBe(true);

    const offer = fileOfferBody(phone.deviceId, {
      transferId: "t1",
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 1,
      totalChunks: 1,
      relativePath: "../evil.pdf",
    });
    expect(
      offer.payload.type === "file_offer" &&
        offer.payload.relativePath === undefined,
    ).toBe(true);

    const asm = new ChunkAssembler({
      transferId: "t1",
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 1,
      totalChunks: 1,
      relativePath: "notes/a.pdf",
    });
    expect(asm.relativePath).toBe("notes/a.pdf");
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

describe("clipboard history payloads", () => {
  test("upsert trims text and rejects empty", () => {
    const long = "x".repeat(MAX_CLIPBOARD_HISTORY_TEXT_CHARS + 50);
    const body = clipboardHistoryUpsertBody("a", {
      id: "h1",
      text: long,
      updatedAt: 1,
    });
    expect(body?.payload.type).toBe("clipboard_history_upsert");
    if (body?.payload.type === "clipboard_history_upsert") {
      expect(body.payload.text.length).toBe(MAX_CLIPBOARD_HISTORY_TEXT_CHARS);
    }
    expect(
      clipboardHistoryUpsertBody("a", { id: "h1", text: "  ", updatedAt: 1 }),
    ).toBeNull();
  });

  test("delete requires id", () => {
    expect(
      clipboardHistoryDeleteBody("a", { id: "h1", updatedAt: 2 }),
    ).not.toBeNull();
    expect(
      clipboardHistoryDeleteBody("a", { id: "", updatedAt: 2 }),
    ).toBeNull();
  });

  test("unknown peer decrypt still fails closed", () => {
    const phone = generateDeviceKeys();
    const desktop = generateDeviceKeys();
    const stranger = generateDeviceKeys();
    const body = clipboardHistoryUpsertBody(phone.deviceId, {
      id: "h1",
      text: "hello",
      updatedAt: 1,
    });
    if (!body) throw new Error("body");
    const frame = encryptFrame(body, phone, {
      deviceId: desktop.deviceId,
      ed25519PublicKey: desktop.ed25519.publicKey,
      x25519PublicKey: desktop.x25519.publicKey,
    });
    const result = decryptFrame(frame, desktop, {
      deviceId: stranger.deviceId,
      ed25519PublicKey: stranger.ed25519.publicKey,
      x25519PublicKey: stranger.x25519.publicKey,
    });
    expect(result.ok).toBe(false);
  });
});
