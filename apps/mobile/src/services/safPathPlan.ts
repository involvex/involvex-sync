import {
  normalizeRelativePath,
  relativePathBasename,
  relativePathDirSegments,
} from "@involvex/protocol";

/**
 * Sanitize a single file or directory name for SAF create calls.
 * Keeps letters, digits, underscore, hyphen, and dot.
 */
export function sanitizeSafName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return cleaned || "file.bin";
}

/**
 * Pure path plan for a SAF (or documentDirectory) save.
 * Invalid relativePath → save basename in the root.
 */
export function planSafSave(
  relativePath: string | undefined,
  fallbackName: string,
): { dirs: string[]; fileName: string } {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return { dirs: [], fileName: sanitizeSafName(fallbackName) };
  }
  return {
    dirs: relativePathDirSegments(normalized).map(sanitizeSafName),
    fileName: sanitizeSafName(relativePathBasename(normalized) ?? fallbackName),
  };
}
