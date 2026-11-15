import { fromBase64, MAX_CHUNKED_FILE_BYTES } from "@involvex/protocol";
import * as FileSystem from "expo-file-system/legacy";
import {
  basenameFromUri,
  guessMime,
  isIgnoredName,
  type WatchItem,
} from "./folderSyncHelpers";

export type { WatchItem } from "./folderSyncHelpers";
export {
  isIgnoredName,
  SizeStabilizer,
  STABLE_CHECKS,
} from "./folderSyncHelpers";

/**
 * List file candidates in the root of a SAF tree URI (no recursion).
 */
export async function listWatchCandidates(
  directoryUri: string,
): Promise<WatchItem[]> {
  const uri = directoryUri.trim();
  if (!uri) return [];
  const entries =
    await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
  const out: WatchItem[] = [];
  for (const childUri of entries) {
    const name = basenameFromUri(childUri);
    if (isIgnoredName(name)) continue;
    try {
      const info = await FileSystem.getInfoAsync(childUri);
      if (!info.exists || info.isDirectory) continue;
      const size =
        "size" in info &&
        typeof info.size === "number" &&
        Number.isFinite(info.size)
          ? info.size
          : 0;
      if (size <= 0 || size > MAX_CHUNKED_FILE_BYTES) continue;
      const mtimeMs =
        "modificationTime" in info &&
        typeof info.modificationTime === "number" &&
        Number.isFinite(info.modificationTime)
          ? Math.floor(info.modificationTime * 1000)
          : 0;
      out.push({ name, uri: childUri, size, mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export async function readWatchFile(item: WatchItem): Promise<{
  name: string;
  mimeType: string;
  data: Uint8Array;
}> {
  const dataBase64 = await FileSystem.readAsStringAsync(item.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return {
    name: item.name,
    mimeType: guessMime(item.name),
    data: fromBase64(dataBase64),
  };
}
