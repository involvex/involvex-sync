import { beforeAll, describe, expect, test } from "bun:test";
import { flattenRelativePath } from "@involvex/protocol";
import { isSynced, ledgerKey, markSynced } from "./folderSyncLedger";

/** Bun has no browser localStorage; give the ledger a Map-backed stub. */
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
});

describe("folderSyncLedger", () => {
  test("flattened ledger key does not change when relativePath is added", () => {
    const relativePath = "notes/2026/a.pdf";
    const relativeName = flattenRelativePath(relativePath);
    expect(relativeName).toBe("notes__2026__a.pdf");

    let ledger = {};
    ledger = markSynced(ledger, relativeName, 100, 1_700_000_000_000);
    // Same size/mtime with the flattened key stays synced even though the
    // wire now carries relativePath for the phone tree.
    expect(isSynced(ledger, relativeName, 100, 1_700_000_000_000)).toBe(true);
    expect(ledgerKey(relativeName, 100, 1_700_000_000_000)).toContain(
      "notes__2026__a.pdf",
    );
    expect(isSynced(ledger, relativePath, 100, 1_700_000_000_000)).toBe(false);
  });
});
