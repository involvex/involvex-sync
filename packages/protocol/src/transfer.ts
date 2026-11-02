import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./hex";
import { FILE_CHUNK_BYTES, MAX_CHUNKED_FILE_BYTES } from "./types";

export type ChunkPlan = {
  transferId: string;
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  chunks: string[]; // base64
  sha256: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Plan a chunked send from raw bytes. Throws if over soft cap. */
export function planChunkedTransfer(
  transferId: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): ChunkPlan {
  if (bytes.byteLength > MAX_CHUNKED_FILE_BYTES) {
    throw new Error(
      `file too large (${bytes.byteLength} > ${MAX_CHUNKED_FILE_BYTES})`,
    );
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES) {
    const slice = bytes.subarray(
      offset,
      Math.min(offset + FILE_CHUNK_BYTES, bytes.byteLength),
    );
    chunks.push(toBase64(slice));
  }
  return {
    transferId,
    name,
    mimeType,
    size: bytes.byteLength,
    totalChunks: chunks.length || 1,
    chunks: chunks.length ? chunks : [""],
    sha256: bytesToHex(sha256(bytes)),
  };
}

export function planChunkedTransferFromBase64(
  transferId: string,
  name: string,
  mimeType: string,
  dataBase64: string,
): ChunkPlan {
  return planChunkedTransfer(
    transferId,
    name,
    mimeType,
    fromBase64(dataBase64),
  );
}

export class ChunkAssembler {
  readonly transferId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly totalChunks: number;
  private parts: (Uint8Array | null)[];
  private received = 0;

  constructor(offer: {
    transferId: string;
    name: string;
    mimeType: string;
    size: number;
    totalChunks: number;
  }) {
    if (offer.size > MAX_CHUNKED_FILE_BYTES) {
      throw new Error("offer exceeds size cap");
    }
    this.transferId = offer.transferId;
    this.name = offer.name;
    this.mimeType = offer.mimeType;
    this.size = offer.size;
    this.totalChunks = offer.totalChunks;
    this.parts = Array.from({ length: offer.totalChunks }, () => null);
  }

  addChunk(index: number, dataBase64: string): void {
    if (index < 0 || index >= this.totalChunks) {
      throw new Error("chunk index out of range");
    }
    if (this.parts[index] !== null) return;
    this.parts[index] = fromBase64(dataBase64);
    this.received += 1;
  }

  get progress(): number {
    return this.totalChunks === 0 ? 1 : this.received / this.totalChunks;
  }

  isComplete(): boolean {
    return this.received >= this.totalChunks;
  }

  finish(expectedSha256: string): Uint8Array {
    if (!this.isComplete()) {
      throw new Error("missing chunks");
    }
    const total = this.parts.reduce((n, p) => n + (p?.byteLength ?? 0), 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      if (!part) throw new Error("missing chunk");
      out.set(part, offset);
      offset += part.byteLength;
    }
    const digest = bytesToHex(sha256(out));
    if (digest !== expectedSha256) {
      throw new Error("sha256 mismatch");
    }
    return out;
  }

  finishBase64(expectedSha256: string): string {
    return toBase64(this.finish(expectedSha256));
  }
}

export { toBase64, fromBase64 };
