import { fromBase64 } from "@involvex/protocol";
import * as FileSystem from "expo-file-system/legacy";
import {
  basenameFromUri,
  collectWatchCandidates,
  guessMime,
  MAX_WATCH_DEPTH,
  type DirStat,
  type WatchItem,
} from "./folderSyncHelpers";

export type {
  DirStat,
  ListDirFn,
  StatFn,
  WatchItem,
} from "./folderSyncHelpers";
export {
  collectWatchCandidates,
  isIgnoredName,
  MAX_WATCH_DEPTH,
  SizeStabilizer,
  STABLE_CHECKS,
  watchLedgerName,
} from "./folderSyncHelpers";

async function safListDir(uri: string): Promise<string[]> {
  return FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
}

async function safStat(uri: string): Promise<DirStat | null> {
  const name = basenameFromUri(uri);
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const size =
      "size" in info &&
      typeof info.size === "number" &&
      Number.isFinite(info.size)
        ? info.size
        : 0;
    const mtimeMs =
      "modificationTime" in info &&
      typeof info.modificationTime === "number" &&
      Number.isFinite(info.modificationTime)
        ? Math.floor(info.modificationTime * 1000)
        : 0;
    return {
      uri,
      name,
      isDirectory: Boolean(info.isDirectory),
      size,
      mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * List file candidates under a SAF tree URI (recursive, depth-capped).
 */
export async function listWatchCandidates(
  directoryUri: string,
  maxDepth: number = MAX_WATCH_DEPTH,
): Promise<WatchItem[]> {
  return collectWatchCandidates(directoryUri, safListDir, safStat, maxDepth);
}

export async function readWatchFile(item: WatchItem): Promise<{
  name: string;
  mimeType: string;
  data: Uint8Array;
  relativePath: string;
}> {
  const dataBase64 = await FileSystem.readAsStringAsync(item.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return {
    name: item.name,
    mimeType: guessMime(item.name),
    data: fromBase64(dataBase64),
    relativePath: item.relativePath,
  };
}
