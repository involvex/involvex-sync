import * as FileSystem from "expo-file-system/legacy";
import {
  isSyncedEntry,
  ledgerKey as makeLedgerKey,
} from "./folderSyncHelpers";

const FILE = `${FileSystem.documentDirectory ?? ""}invx-folder-sync-ledger.json`;

export type LedgerKey = string;

export type LedgerEntry = {
  size: number;
  mtimeMs: number;
};

export type FolderSyncLedger = Record<LedgerKey, LedgerEntry>;

export function ledgerKey(
  relativeName: string,
  size: number,
  mtimeMs: number,
): LedgerKey {
  return makeLedgerKey(relativeName, size, mtimeMs);
}

export async function loadLedger(): Promise<FolderSyncLedger> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw) as FolderSyncLedger;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveLedger(ledger: FolderSyncLedger): Promise<void> {
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(ledger));
}

export function isSynced(
  ledger: FolderSyncLedger,
  relativeName: string,
  size: number,
  mtimeMs: number,
): boolean {
  return isSyncedEntry(ledger, relativeName, size, mtimeMs);
}

export async function markSynced(
  ledger: FolderSyncLedger,
  relativeName: string,
  size: number,
  mtimeMs: number,
): Promise<FolderSyncLedger> {
  const next: FolderSyncLedger = {
    ...ledger,
    [ledgerKey(relativeName, size, mtimeMs)]: { size, mtimeMs },
  };
  const keys = Object.keys(next);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) {
      delete next[k];
    }
  }
  await saveLedger(next);
  return next;
}
