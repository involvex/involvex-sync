import { hashText } from "./crypto.js";

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
 */
export class LoopGuard {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly entries: Entry[] = [];

  constructor(options: LoopGuardOptions = {}) {
    this.windowMs = options.windowMs ?? 5_000;
    this.maxEntries = options.maxEntries ?? 64;
  }

  remember(text: string, sourceDeviceId: string, now = Date.now()): void {
    this.prune(now);
    this.entries.push({
      hash: hashText(text),
      sourceDeviceId,
      expiresAt: now + this.windowMs,
    });
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Returns true when a local clipboard change matches a recent remote apply
   * and should not be rebroadcast.
   */
  shouldSkipOutbound(
    text: string,
    localDeviceId: string,
    now = Date.now(),
  ): boolean {
    this.prune(now);
    const hash = hashText(text);
    return this.entries.some(
      (e) => e.hash === hash && e.sourceDeviceId !== localDeviceId,
    );
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
