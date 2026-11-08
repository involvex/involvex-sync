const KEY = "invx.driveSyncLedger";

export type DriveLedgerKey = string;

export type DriveLedgerEntry = {
  size: number;
  mtimeMs: number;
  /** Drive file id from last successful upload, when known. */
  fileId?: string;
};

export type DriveSyncLedger = Record<DriveLedgerKey, DriveLedgerEntry>;

export function driveLedgerKey(
  relativeName: string,
  size: number,
  mtimeMs: number,
): DriveLedgerKey {
  return `${relativeName}|${size}|${mtimeMs}`;
}

export function loadDriveLedger(): DriveSyncLedger {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DriveSyncLedger;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveDriveLedger(ledger: DriveSyncLedger): void {
  localStorage.setItem(KEY, JSON.stringify(ledger));
}

export function isDriveSynced(
  ledger: DriveSyncLedger,
  relativeName: string,
  size: number,
  mtimeMs: number,
): boolean {
  const key = driveLedgerKey(relativeName, size, mtimeMs);
  const hit = ledger[key];
  return Boolean(hit && hit.size === size && hit.mtimeMs === mtimeMs);
}

/** True when a Drive file id was recorded by a previous successful upload. */
export function hasDriveFileId(
  ledger: DriveSyncLedger,
  fileId: string,
): boolean {
  for (const entry of Object.values(ledger)) {
    if (entry.fileId === fileId) return true;
  }
  return false;
}

export function markDriveSynced(
  ledger: DriveSyncLedger,
  relativeName: string,
  size: number,
  mtimeMs: number,
  fileId?: string,
): DriveSyncLedger {
  const next: DriveSyncLedger = {
    ...ledger,
    [driveLedgerKey(relativeName, size, mtimeMs)]: {
      size,
      mtimeMs,
      ...(fileId ? { fileId } : {}),
    },
  };
  const keys = Object.keys(next);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) {
      delete next[k];
    }
  }
  saveDriveLedger(next);
  return next;
}
