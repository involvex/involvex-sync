import { hashText } from "./crypto";

export type LoopGuardOptions = {
  /** How long to remember a hash (ms). Default 5s. */
  windowMs?: number;
  /** Max remembered entries. Default 64. */
  maxEntries?: number;
};

type Entry = {
  hash: string;
  sourceDeviceId: string;
  expiresAt: number;
};

/**
 * Prevents clipboard echo loops: A → B → A.
 * Remember (hash, source) for a short window after applying a remote update.
 * Hash may be sha256 of text (via hashText) or of image bytes.
 */
export class LoopGuard {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly entries: Entry[] = [];

  constructor(options: LoopGuardOptions = {}) {
    this.windowMs = options.windowMs ?? 5_000;
    this.maxEntries = options.maxEntries ?? 64;
  }

  rememberHash(hash: string, sourceDeviceId: string, now = Date.now()): void {
    if (!hash) return;
    this.prune(now);
    this.entries.push({
      hash,
      sourceDeviceId,
      expiresAt: now + this.windowMs,
    });
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  remember(text: string, sourceDeviceId: string, now = Date.now()): void {
    this.rememberHash(hashText(text), sourceDeviceId, now);
  }

  /**
   * Returns true when a local clipboard change matches a recent remote apply
   * and should not be rebroadcast.
   */
  shouldSkipOutboundHash(
    hash: string,
    localDeviceId: string,
    now = Date.now(),
  ): boolean {
    if (!hash) return false;
    this.prune(now);
    return this.entries.some(
      (e) => e.hash === hash && e.sourceDeviceId !== localDeviceId,
    );
  }

  shouldSkipOutbound(
    text: string,
    localDeviceId: string,
    now = Date.now(),
  ): boolean {
    return this.shouldSkipOutboundHash(hashText(text), localDeviceId, now);
  }

  clear(): void {
    this.entries.length = 0;
  }

  private prune(now: number): void {
    while (this.entries.length > 0) {
      const head = this.entries[0];
      if (!head || head.expiresAt > now) break;
      this.entries.shift();
    }
  }
}
