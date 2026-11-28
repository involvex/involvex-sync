import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  appendClipboardHistory,
  applyPeerHistoryDelete,
  applyPeerHistoryUpsert,
  clearClipboardHistory,
  filterClipboardHistory,
  listSharedClipboardHistory,
  loadClipboardHistory,
  removeClipboardHistory,
  setClipboardHistoryMax,
  sortClipboardHistory,
  toggleClipboardHistoryPin,
} from "./clipboardHistory";

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

beforeEach(() => {
  setClipboardHistoryMax(50);
  clearClipboardHistory();
});

describe("clipboardHistory shared merge", () => {
  test("append returns entry for fan-out", () => {
    const { entries, entry } = appendClipboardHistory("hello", "out");
    expect(entry?.text).toBe("hello");
    expect(entries[0]?.id).toBe(entry?.id);
  });

  test("peer upsert replaces same-text local append", () => {
    appendClipboardHistory("hello", "in");
    const next = applyPeerHistoryUpsert({
      id: "shared-1",
      text: "hello",
      updatedAt: Date.now() + 10,
    });
    expect(next.filter((e) => e.text === "hello")).toHaveLength(1);
    expect(next[0]?.id).toBe("shared-1");
  });

  test("older peer upsert loses to newer local", () => {
    applyPeerHistoryUpsert({ id: "a", text: "x", updatedAt: 100 });
    const next = applyPeerHistoryUpsert({ id: "a", text: "y", updatedAt: 50 });
    expect(next[0]?.text).toBe("x");
  });

  test("delete and listShared skips images", () => {
    appendClipboardHistory("t", "out");
    appendClipboardHistory("[Image]", "out", {
      kind: "image",
      imagePath: "C:\\a.png",
    });
    expect(listSharedClipboardHistory()).toHaveLength(1);
    const id = loadClipboardHistory().find((e) => e.text === "t")!.id;
    applyPeerHistoryDelete(id, Date.now());
    expect(listSharedClipboardHistory()).toHaveLength(0);
    const rem = removeClipboardHistory(
      loadClipboardHistory().find((e) => e.kind === "image")!.id,
    );
    expect(rem.removed?.kind).toBe("image");
  });
});

describe("clipboardHistory pin search retention", () => {
  test("pin survives load/save", () => {
    const { entry } = appendClipboardHistory("keep me", "out");
    expect(entry).not.toBeNull();
    const { entries, entry: pinned } = toggleClipboardHistoryPin(entry!.id);
    expect(pinned?.pinned).toBe(true);
    expect(entries.find((e) => e.id === entry!.id)?.pinned).toBe(true);
    expect(loadClipboardHistory().find((e) => e.id === entry!.id)?.pinned).toBe(
      true,
    );
  });

  test("peer same-text replace preserves local pin", () => {
    const { entry } = appendClipboardHistory("hello", "out");
    toggleClipboardHistoryPin(entry!.id);
    const next = applyPeerHistoryUpsert({
      id: "shared-1",
      text: "hello",
      updatedAt: Date.now() + 10,
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("shared-1");
    expect(next[0]?.pinned).toBe(true);
  });

  test("peer same-id replace preserves pin", () => {
    applyPeerHistoryUpsert({ id: "a", text: "one", updatedAt: 10 });
    toggleClipboardHistoryPin("a");
    const next = applyPeerHistoryUpsert({
      id: "a",
      text: "two",
      updatedAt: 20,
    });
    expect(next[0]?.text).toBe("two");
    expect(next[0]?.pinned).toBe(true);
  });

  test("filterClipboardHistory is case-insensitive", () => {
    appendClipboardHistory("Hello World", "out");
    appendClipboardHistory("other", "out");
    const rows = loadClipboardHistory();
    expect(filterClipboardHistory(rows, "hello")).toHaveLength(1);
    expect(filterClipboardHistory(rows, "WORLD")[0]?.text).toBe("Hello World");
    expect(filterClipboardHistory(rows, "")).toHaveLength(2);
  });

  test("sortClipboardHistory puts pinned first", () => {
    appendClipboardHistory("a", "out");
    appendClipboardHistory("b", "out");
    const idA = loadClipboardHistory().find((e) => e.text === "a")!.id;
    toggleClipboardHistoryPin(idA);
    const sorted = sortClipboardHistory(loadClipboardHistory());
    expect(sorted[0]?.text).toBe("a");
    expect(sorted[0]?.pinned).toBe(true);
  });

  test("retention max evicts unpinned but keeps pinned", () => {
    setClipboardHistoryMax(2);
    const { entry: pinMe } = appendClipboardHistory("pinned", "out");
    toggleClipboardHistoryPin(pinMe!.id);
    appendClipboardHistory("one", "out");
    appendClipboardHistory("two", "out");
    appendClipboardHistory("three", "out");
    const rows = loadClipboardHistory();
    expect(rows.some((e) => e.text === "pinned" && e.pinned)).toBe(true);
    expect(rows.filter((e) => !e.pinned)).toHaveLength(2);
    expect(rows.filter((e) => !e.pinned).map((e) => e.text)).toEqual([
      "three",
      "two",
    ]);
  });

  test("listShared still caps at protocol soft max", () => {
    setClipboardHistoryMax(10);
    for (let i = 0; i < 12; i++) {
      appendClipboardHistory(`row-${i}`, "out");
    }
    const shared = listSharedClipboardHistory();
    expect(shared.length).toBeLessThanOrEqual(10);
    expect(shared.every((e) => (e.kind ?? "text") === "text")).toBe(true);
  });
});
