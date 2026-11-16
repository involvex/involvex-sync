import { beforeEach, describe, expect, test } from "bun:test";
import {
  deleteLocalNote,
  loadNotes,
  loadNotesRaw,
  upsertLocalNote,
} from "./notesStore";

/** Bun has no browser localStorage; give notesStore a Map-backed stub. */
function installLocalStorage(): void {
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
}

beforeEach(() => {
  installLocalStorage();
});

describe("notesStore raw load", () => {
  test("loadNotesRaw includes a tombstone that loadNotes hides", () => {
    const { note } = upsertLocalNote({ title: "keep", body: "a" });
    const { note: doomed } = upsertLocalNote({ title: "gone", body: "b" });
    deleteLocalNote(doomed.id);

    const visible = loadNotes();
    expect(visible.map((n) => n.id)).toEqual([note.id]);
    expect(visible.every((n) => !n.deleted)).toBe(true);

    const raw = loadNotesRaw();
    const tombstone = raw.find((n) => n.id === doomed.id);
    expect(tombstone).toBeDefined();
    expect(tombstone?.deleted).toBe(true);
    expect(raw.some((n) => n.id === note.id && !n.deleted)).toBe(true);
  });
});
