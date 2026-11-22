/**
 * Relay mailbox limits. Live forward must fit a sealed `file_chunk` of
 * FILE_CHUNK_BYTES (~176 KiB measured); the offline queue stays small so a
 * photo cannot evict clipboard/link/note frames.
 */

/** Max raw JSON chars for a live-forwarded relay frame (sealed 64 KiB chunk ≈ 176 KiB). */
export const RELAY_LIVE_MAX_CHARS = 262_144;

/** Max raw JSON chars that may enter the offline mailbox. */
export const RELAY_QUEUE_MAX_CHARS = 8_192;

/** Offline mailbox depth. */
export const RELAY_QUEUE_MAX = 32;

/** Offline mailbox TTL. */
export const RELAY_QUEUE_TTL_MS = 5 * 60_000;

/** Stable pair room id: `A:B` and `B:A` sort the same. */
export function normalizePairId(raw: string): string {
  const parts = raw.split(":").filter(Boolean);
  if (parts.length === 2) {
    return [...parts].sort().join(":");
  }
  return raw;
}
