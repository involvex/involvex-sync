const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Returns a normalized http(s) URL, or null if the string is not safe to open.
 * Rejects file:, javascript:, intent:, data:, and anything with credentials.
 */
export function parseAllowedUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 8192) return null;

  // Prefer an explicit URL; otherwise look for the first http(s) token.
  const candidate = extractUrlCandidate(trimmed);
  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;

  // Block localhost / link-local when opening remotely is not relevant;
  // still allow them for LAN testing (user's own machines).
  return url.toString();
}

function extractUrlCandidate(text: string): string | null {
  if (/^https?:\/\//i.test(text)) {
    // Take first line / whitespace-bounded token
    const token = text.split(/\s/)[0];
    return token ?? null;
  }

  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0] ?? null;
}

/** True when the string looks like a shareable link. */
export function looksLikeUrl(text: string): boolean {
  return parseAllowedUrl(text) !== null;
}
