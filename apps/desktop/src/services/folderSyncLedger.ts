const KEY = "invx.folderSyncLedger";

export type LedgerKey = string;

export type LedgerEntry = {
  size: number;
  mtimeMs: number;
};

export type FolderSyncLedger = Record<LedgerKey, LedgerEntry>;

export function ledgerKey(relativeName: string, size: number, mtimeMs: number): LedgerKey {
  return `${relativeName}|${size}|${mtimeMs}`;
}

export function loadLedger(): FolderSyncLedger {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as FolderSyncLedger;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveLedger(ledger: FolderSyncLedger): void {
  localStorage.setItem(KEY, JSON.stringify(ledger));
}

export function isSynced(
  ledger: FolderSyncLedger,
  relativeName: string,
  size: number,
  mtimeMs: number,
): boolean {
  const key = ledgerKey(relativeName, size, mtimeMs);
  const hit = ledger[key];
  return Boolean(hit && hit.size === size && hit.mtimeMs === mtimeMs);
}

export function markSynced(
  ledger: FolderSyncLedger,
  relativeName: string,
  size: number,
  mtimeMs: number,
): FolderSyncLedger {
  const next = {
    ...ledger,
    [ledgerKey(relativeName, size, mtimeMs)]: { size, mtimeMs },
  };
  // Cap growth: keep last ~500 entries by dropping oldest keys.
  const keys = Object.keys(next);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) {
      delete next[k];
    }
  }
  saveLedger(next);
  return next;
}
