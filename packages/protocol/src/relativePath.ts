/** Max directory + file segments in a file transfer relativePath. */
export const MAX_RELATIVE_PATH_DEPTH = 8;

/** Max characters for a single path segment (basename or directory name). */
export const MAX_RELATIVE_PATH_SEGMENT_CHARS = 200;

/** Max characters for the whole relativePath string. */
export const MAX_RELATIVE_PATH_CHARS = 1_000;

/** Windows / path-separator characters that must not appear in a segment. */
const FORBIDDEN_SEGMENT_CHARS = new Set([
  "\\",
  "/",
  ":",
  "*",
  "?",
  '"',
  "<",
  ">",
  "|",
]);

function isValidSegment(segment: string): boolean {
  if (!segment || segment.length > MAX_RELATIVE_PATH_SEGMENT_CHARS)
    return false;
  if (segment === "." || segment === "..") return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 32) return false;
    if (FORBIDDEN_SEGMENT_CHARS.has(segment[i]!)) return false;
  }
  return true;
}

/**
 * Split and validate a relative path (`notes/2026/a.pdf`).
 * Returns segments or `null` when invalid (absolute, `..`, empty, too deep).
 */
export function parseRelativePathSegments(
  raw: string | undefined | null,
): string[] | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.length > MAX_RELATIVE_PATH_CHARS) return null;
  if (trimmed.startsWith("/") || trimmed.includes(":")) return null;
  const parts = trimmed.split("/").filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > MAX_RELATIVE_PATH_DEPTH) return null;
  if (!parts.every(isValidSegment)) return null;
  return parts;
}

/**
 * Normalize a relative path for the wire: forward slashes, validated.
 * Returns `undefined` when missing or invalid (caller falls back to basename).
 */
export function normalizeRelativePath(
  raw: string | undefined | null,
): string | undefined {
  const parts = parseRelativePathSegments(raw);
  if (!parts) return undefined;
  return parts.join("/");
}

/** Last segment of a relative path, or `undefined` if invalid/empty. */
export function relativePathBasename(
  raw: string | undefined | null,
): string | undefined {
  const parts = parseRelativePathSegments(raw);
  if (!parts || parts.length === 0) return undefined;
  return parts[parts.length - 1];
}

/**
 * Directory segments only (everything except the basename).
 * Empty array when the file sits at the sync root.
 */
export function relativePathDirSegments(
  raw: string | undefined | null,
): string[] {
  const parts = parseRelativePathSegments(raw);
  if (!parts || parts.length <= 1) return [];
  return parts.slice(0, -1);
}

/** Flatten `a/b/c.pdf` → `a__b__c.pdf` (desktop ledger / Drive object title). */
export function flattenRelativePath(raw: string): string {
  const parts = parseRelativePathSegments(raw);
  if (!parts) return raw.replace(/[\\/]+/g, "__");
  return parts.join("__");
}
