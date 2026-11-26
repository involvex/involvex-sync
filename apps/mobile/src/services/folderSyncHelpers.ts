import {
  flattenRelativePath,
  MAX_CHUNKED_FILE_BYTES,
  MAX_RELATIVE_PATH_DEPTH,
  normalizeRelativePath,
} from "@involvex/protocol";

export type WatchItem = {
  name: string;
  uri: string;
  size: number;
  mtimeMs: number;
  /**
   * Slash path under the watch root (`notes/2026/a.pdf`).
   * Root-level files use the basename alone.
   */
  relativePath: string;
};

export type DirStat = {
  uri: string;
  name: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
};

export type ListDirFn = (uri: string) => Promise<string[]>;
export type StatFn = (uri: string) => Promise<DirStat | null>;

/** Size must match across this many consecutive polls before enqueue. */
export const STABLE_CHECKS = 2;

/** Match protocol max segments (dirs + file) for relativePath. */
export const MAX_WATCH_DEPTH = MAX_RELATIVE_PATH_DEPTH;

/**
 * Recursively collect file candidates under a directory URI.
 * Depth is the number of relativePath segments (dirs + file), capped at
 * {@link MAX_WATCH_DEPTH}. Cycles are skipped via a visited-URI set.
 */
export async function collectWatchCandidates(
  rootUri: string,
  listDir: ListDirFn,
  stat: StatFn,
  maxDepth: number = MAX_WATCH_DEPTH,
): Promise<WatchItem[]> {
  const root = rootUri.trim();
  if (!root) return [];
  const depthCap = Math.min(
    Math.max(1, Math.floor(maxDepth)),
    MAX_RELATIVE_PATH_DEPTH,
  );
  const out: WatchItem[] = [];
  const visited = new Set<string>();

  async function walk(
    dirUri: string,
    dirSegments: readonly string[],
  ): Promise<void> {
    if (visited.has(dirUri)) return;
    visited.add(dirUri);
    if (dirSegments.length >= depthCap) return;

    let childUris: string[];
    try {
      childUris = await listDir(dirUri);
    } catch {
      return;
    }

    for (const childUri of childUris) {
      if (visited.has(childUri)) continue;
      const name = basenameFromUri(childUri);
      if (isIgnoredName(name)) continue;

      const info = await stat(childUri);
      if (!info) continue;

      if (info.isDirectory) {
        const nextSegments = [...dirSegments, info.name];
        if (nextSegments.length >= depthCap) continue;
        const check = joinRelativeSegments(nextSegments, "x");
        if (!check) continue;
        await walk(childUri, nextSegments);
        continue;
      }

      const relativePath = joinRelativeSegments(dirSegments, info.name);
      if (!relativePath) continue;
      if (info.size <= 0 || info.size > MAX_CHUNKED_FILE_BYTES) continue;

      out.push({
        name: info.name,
        uri: childUri,
        size: info.size,
        mtimeMs: info.mtimeMs,
        relativePath,
      });
    }
  }

  await walk(root, []);
  return out;
}

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

/**
 * Ledger / Drive-style key for a watch item: flatten `a/b/c.pdf` → `a__b__c.pdf`.
 */
export function watchLedgerName(
  item: Pick<WatchItem, "relativePath" | "name">,
): string {
  const normalized = normalizeRelativePath(item.relativePath);
  if (normalized) return flattenRelativePath(normalized);
  return item.name;
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

/** Join path segments with `/`, or return basename alone when empty prefix. */
export function joinRelativeSegments(
  dirSegments: readonly string[],
  fileName: string,
): string | null {
  const parts = [...dirSegments, fileName];
  return normalizeRelativePath(parts.join("/")) ?? null;
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
