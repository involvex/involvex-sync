import * as FileSystem from "expo-file-system/legacy";
import { basenameFromUri } from "./folderSyncHelpers";
import { planSafSave, sanitizeSafName } from "./safPathPlan";

export { planSafSave, sanitizeSafName } from "./safPathPlan";

/**
 * Find an existing child directory URI under `parentUri` whose basename
 * matches `dirName`, or create it.
 */
export async function ensureSafDirectory(
  parentUri: string,
  dirName: string,
): Promise<string> {
  const safe = sanitizeSafName(dirName);
  const children =
    await FileSystem.StorageAccessFramework.readDirectoryAsync(parentUri);
  for (const child of children) {
    if (basenameFromUri(child) === safe) {
      try {
        await FileSystem.StorageAccessFramework.readDirectoryAsync(child);
        return child;
      } catch {
        // Not a readable directory — keep looking / create.
      }
    }
  }
  return FileSystem.StorageAccessFramework.makeDirectoryAsync(parentUri, safe);
}

/**
 * Walk `relativePath` under a SAF root, creating directories as needed.
 * Returns the parent directory URI for the file (last dir) and the basename.
 * Invalid paths fall back to saving in the root with a sanitized basename.
 */
export async function resolveSafSaveTarget(
  rootUri: string,
  relativePath: string | undefined,
  fallbackName: string,
): Promise<{ parentUri: string; fileName: string }> {
  const plan = planSafSave(relativePath, fallbackName);
  let parent = rootUri;
  for (const dir of plan.dirs) {
    parent = await ensureSafDirectory(parent, dir);
  }
  return { parentUri: parent, fileName: plan.fileName };
}
