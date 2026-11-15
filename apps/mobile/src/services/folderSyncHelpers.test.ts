import { describe, expect, test } from "bun:test";
import {
  isIgnoredName,
  isSyncedEntry,
  ledgerKey,
  SizeStabilizer,
  STABLE_CHECKS,
} from "./folderSyncHelpers";

describe("folderSyncHelpers", () => {
  test("ledgerKey joins name size mtime", () => {
    expect(ledgerKey("a.pdf", 10, 100)).toBe("a.pdf|10|100");
  });

  test("isSyncedEntry matches exact size and mtime", () => {
    const ledger = {
      [ledgerKey("a.pdf", 10, 100)]: { size: 10, mtimeMs: 100 },
    };
    expect(isSyncedEntry(ledger, "a.pdf", 10, 100)).toBe(true);
    expect(isSyncedEntry(ledger, "a.pdf", 11, 100)).toBe(false);
    expect(isSyncedEntry(ledger, "a.pdf", 10, 101)).toBe(false);
    expect(isSyncedEntry(ledger, "b.pdf", 10, 100)).toBe(false);
  });

  test("isIgnoredName matches desktop rules", () => {
    expect(isIgnoredName(".hidden")).toBe(true);
    expect(isIgnoredName("foo.tmp")).toBe(true);
    expect(isIgnoredName("bar.crdownload")).toBe(true);
    expect(isIgnoredName("Thumbs.db")).toBe(true);
    expect(isIgnoredName("report.pdf")).toBe(false);
  });

  test("SizeStabilizer requires consecutive stable sizes", () => {
    const s = new SizeStabilizer();
    const item = {
      name: "a.bin",
      uri: "content://a",
      size: 10,
      mtimeMs: 1,
    };
    expect(s.observe(item)).toBe(STABLE_CHECKS <= 1);
    if (STABLE_CHECKS > 1) {
      expect(s.observe(item)).toBe(true);
    }
    expect(s.observe({ ...item, size: 11 })).toBe(STABLE_CHECKS <= 1);
  });
});
