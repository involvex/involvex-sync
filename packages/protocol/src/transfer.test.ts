import { describe, expect, test } from "bun:test";
import { bytesToHex } from "./hex";
import { sha256 } from "@noble/hashes/sha2.js";
import { ChunkAssembler, planChunkedTransfer, toBase64 } from "./transfer";
import { FILE_CHUNK_BYTES } from "./types";

describe("chunked transfer", () => {
  test("roundtrip plan + assemble", () => {
    const size = FILE_CHUNK_BYTES * 2 + 100;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    const plan = planChunkedTransfer(
      "t1",
      "a.bin",
      "application/octet-stream",
      bytes,
    );
    expect(plan.totalChunks).toBe(3);
    expect(plan.sha256).toBe(bytesToHex(sha256(bytes)));

    const asm = new ChunkAssembler(plan);
    plan.chunks.forEach((c, i) => asm.addChunk(i, c));
    expect(asm.isComplete()).toBe(true);
    const out = asm.finish(plan.sha256);
    expect(out).toEqual(bytes);
    expect(toBase64(out).length).toBeGreaterThan(0);
  });
});
