import { describe, expect, test } from "bun:test";
import {
  deriveAeadKey,
  fingerprint,
  generateDeviceKeys,
  hashText,
  open,
  seal,
  sharedSecret,
  signFrame,
  verifyFrame,
} from "./crypto";
import { PROTOCOL_VERSION } from "./types";

describe("crypto", () => {
  test("X25519 shared secrets match", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const ab = sharedSecret(a.x25519.privateKey, b.x25519.publicKey);
    const ba = sharedSecret(b.x25519.privateKey, a.x25519.publicKey);
    expect(Buffer.from(ab).equals(Buffer.from(ba))).toBe(true);
  });

  test("seal/open roundtrip", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const key = deriveAeadKey(
      sharedSecret(a.x25519.privateKey, b.x25519.publicKey),
    );
    const { nonce, ciphertext } = seal("hello involvex", key);
    expect(open(ciphertext, nonce, key)).toBe("hello involvex");
  });

  test("tampered ciphertext fails", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const key = deriveAeadKey(
      sharedSecret(a.x25519.privateKey, b.x25519.publicKey),
    );
    const { nonce, ciphertext } = seal("secret", key);
    const flipped = `${ciphertext.slice(0, -2)}ff`;
    expect(() => open(flipped, nonce, key)).toThrow();
  });

  test("ed25519 frame signature verifies", () => {
    const keys = generateDeviceKeys();
    const nonce = "aa".repeat(24);
    const ct = "bb".repeat(32);
    const sig = signFrame(
      PROTOCOL_VERSION,
      keys.deviceId,
      nonce,
      ct,
      keys.ed25519.privateKey,
    );
    expect(
      verifyFrame(
        PROTOCOL_VERSION,
        keys.deviceId,
        nonce,
        ct,
        sig,
        keys.ed25519.publicKey,
      ),
    ).toBe(true);
    expect(
      verifyFrame(
        PROTOCOL_VERSION,
        keys.deviceId,
        nonce,
        "cc".repeat(32),
        sig,
        keys.ed25519.publicKey,
      ),
    ).toBe(false);
  });

  test("fingerprint is stable short form", () => {
    const keys = generateDeviceKeys("deadbeef");
    const fp = fingerprint(keys.ed25519.publicKey);
    expect(fp).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/);
    expect(fingerprint(keys.ed25519.publicKey)).toBe(fp);
  });

  test("hashText is deterministic", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});
