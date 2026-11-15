export type WatchItem = {
  name: string;
  uri: string;
  size: number;
  mtimeMs: number;
};

/** Size must match across this many consecutive polls before enqueue. */
export const STABLE_CHECKS = 2;

export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase();
  if (name.startsWith(".")) return true;
  return (
    lower.endsWith(".tmp") ||
    lower.endsWith(".temp") ||
    lower.endsWith(".partial") ||
    lower.endsWith(".crdownload") ||
    lower.endsWith(".download") ||
    name.endsWith("~") ||
    lower === "thumbs.db" ||
    lower === "desktop.ini"
  );
}

export function ledgerKey(
  relativeName: string,
  size: number,
  mtimeMs: number,
): string {
  return `${relativeName}|${size}|${mtimeMs}`;
}

export function isSyncedEntry(
  ledger: Record<string, { size: number; mtimeMs: number }>,
  relativeName: string,
  size: number,
  mtimeMs: number,
): boolean {
  const hit = ledger[ledgerKey(relativeName, size, mtimeMs)];
  return Boolean(hit && hit.size === size && hit.mtimeMs === mtimeMs);
}

/** Track size stability across polls. */
export class SizeStabilizer {
  private seen = new Map<string, { size: number; hits: number }>();

  /**
   * Returns true once `item` has reported the same size for STABLE_CHECKS
   * consecutive observations (including this one).
   */
  observe(item: WatchItem): boolean {
    const key = item.uri;
    const prev = this.seen.get(key);
    if (!prev || prev.size !== item.size) {
      this.seen.set(key, { size: item.size, hits: 1 });
      return STABLE_CHECKS <= 1;
    }
    const hits = prev.hits + 1;
    this.seen.set(key, { size: item.size, hits });
    return hits >= STABLE_CHECKS;
  }

  prune(activeUris: Set<string>): void {
    for (const key of this.seen.keys()) {
      if (!activeUris.has(key)) this.seen.delete(key);
    }
  }
}

export function basenameFromUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const slash = Math.max(decoded.lastIndexOf("/"), decoded.lastIndexOf(":"));
    const raw = slash >= 0 ? decoded.slice(slash + 1) : decoded;
    return raw.split("?")[0] || "file";
  } catch {
    return "file";
  }
}

export function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}
