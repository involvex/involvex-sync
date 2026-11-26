import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  appendClipboardHistory,
  applyPeerHistoryDelete,
  applyPeerHistoryUpsert,
  clearClipboardHistory,
  listSharedClipboardHistory,
  loadClipboardHistory,
  removeClipboardHistory,
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
