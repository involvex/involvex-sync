import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import type { DeviceKeys, KeyPairHex } from "./types.js";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function generateDeviceId(): string {
  return bytesToHex(randomBytes(16));
}

export function generateEd25519KeyPair(): KeyPairHex {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

export function generateX25519KeyPair(): KeyPairHex {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

export function generateDeviceKeys(deviceId?: string): DeviceKeys {
  return {
    deviceId: deviceId ?? generateDeviceId(),
    ed25519: generateEd25519KeyPair(),
    x25519: generateX25519KeyPair(),
  };
}

/** Short fingerprint shown during QR pairing. */
export function fingerprint(publicKeyHex: string): string {
  const digest = sha256(hexToBytes(publicKeyHex));
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const byte = digest[i];
    if (byte === undefined) break;
    parts.push(byte.toString(16).padStart(2, "0").toUpperCase());
  }
  return parts.join(":");
}

export function hashText(text: string): string {
  return bytesToHex(sha256(utf8.encode(text)));
}

export function sharedSecret(
  ourPrivateX25519Hex: string,
  theirPublicX25519Hex: string,
): Uint8Array {
  return x25519.getSharedSecret(
    hexToBytes(ourPrivateX25519Hex),
    hexToBytes(theirPublicX25519Hex),
  );
}

/**
 * Derive a 32-byte AEAD key from the raw X25519 shared secret.
 * Domain-separated so the same DH cannot be reused elsewhere.
 */
export function deriveAeadKey(shared: Uint8Array): Uint8Array {
  return sha256(
    Uint8Array.from([...utf8.encode("involvex-sync-v1-aead"), ...shared]),
  );
}

export function seal(
  plaintext: string,
  aeadKey: Uint8Array,
  nonce?: Uint8Array,
): { nonce: string; ciphertext: string } {
  const n = nonce ?? randomBytes(24);
  const cipher = xchacha20poly1305(aeadKey, n);
  const ct = cipher.encrypt(utf8.encode(plaintext));
  return {
    nonce: bytesToHex(n),
    ciphertext: bytesToHex(ct),
  };
}

export function open(
  ciphertextHex: string,
  nonceHex: string,
  aeadKey: Uint8Array,
): string {
  const cipher = xchacha20poly1305(aeadKey, hexToBytes(nonceHex));
  const pt = cipher.decrypt(hexToBytes(ciphertextHex));
  return utf8d.decode(pt);
}

/** Bytes that Ed25519 signs for a wire frame. */
export function frameSignInput(
  version: number,
  from: string,
  nonceHex: string,
  ciphertextHex: string,
): Uint8Array {
  return utf8.encode(`v${version}|${from}|${nonceHex}|${ciphertextHex}`);
}

export function signFrame(
  version: number,
  from: string,
  nonceHex: string,
  ciphertextHex: string,
  ed25519PrivateKeyHex: string,
): string {
  const msg = frameSignInput(version, from, nonceHex, ciphertextHex);
  return bytesToHex(ed25519.sign(msg, hexToBytes(ed25519PrivateKeyHex)));
}

export function verifyFrame(
  version: number,
  from: string,
  nonceHex: string,
  ciphertextHex: string,
  signatureHex: string,
  ed25519PublicKeyHex: string,
): boolean {
  try {
    const msg = frameSignInput(version, from, nonceHex, ciphertextHex);
    return ed25519.verify(
      hexToBytes(signatureHex),
      msg,
      hexToBytes(ed25519PublicKeyHex),
    );
  } catch {
    return false;
  }
}
