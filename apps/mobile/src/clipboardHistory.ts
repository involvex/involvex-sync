import {
  MAX_CLIPBOARD_HISTORY,
  MAX_CLIPBOARD_HISTORY_TEXT_CHARS,
} from "@involvex/protocol";
import * as SecureStore from "expo-secure-store";

const KEY = "invx.clipboard.history";
const DEFAULT_MAX = MAX_CLIPBOARD_HISTORY;
/** SecureStore payload budget — keep under ~2 KiB per write on some OEMs. */
const STORE_TEXT_CHARS = Math.min(800, MAX_CLIPBOARD_HISTORY_TEXT_CHARS);

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  ts: number;
  updatedAt: number;
  direction: "in" | "out" | "local";
  kind?: "text" | "image";
  /** Local file URI for image entries (optional). */
  imageUri?: string;
  /** Local-only favourite; never sent on the wire. */
  pinned?: boolean;
};

let retentionMax = DEFAULT_MAX;

/** Cap for local retention (pinned rows are kept outside the unpinned budget). */
export function setClipboardHistoryMax(max: number): void {
  retentionMax =
    Number.isFinite(max) && max > 0
      ? Math.min(Math.floor(max), DEFAULT_MAX * 2)
      : DEFAULT_MAX;
}

export function getClipboardHistoryMax(): number {
  return retentionMax;
}

function normalizeEntry(
  raw: Partial<ClipboardHistoryEntry> & { id: string; text: string },
): ClipboardHistoryEntry {
  const ts =
    typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : Date.now();
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : ts;
  return {
    id: raw.id,
    text: raw.text,
    ts,
    updatedAt,
    direction: raw.direction ?? "local",
    kind: raw.kind ?? "text",
    imageUri: raw.imageUri,
    pinned: raw.pinned === true ? true : undefined,
  };
}

function prune(
  entries: ClipboardHistoryEntry[],
  max = retentionMax,
): ClipboardHistoryEntry[] {
  const sorted = entries
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || b.ts - a.ts);
  const pinned = sorted.filter((e) => e.pinned);
  const unpinned = sorted.filter((e) => !e.pinned);
  // Pinned rows sit outside the retention cap.
  return [...pinned, ...unpinned.slice(0, max)].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.ts - a.ts,
  );
}

function trimText(text: string, max = STORE_TEXT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Case-insensitive substring filter on `text`. Empty query returns all. */
export function filterClipboardHistory(
  entries: ClipboardHistoryEntry[],
  query: string,
): ClipboardHistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.text.toLowerCase().includes(q));
}

/** Pinned first, then by updatedAt/ts descending. */
export function sortClipboardHistory(
  entries: ClipboardHistoryEntry[],
): ClipboardHistoryEntry[] {
  return entries.slice().sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    return b.updatedAt - a.updatedAt || b.ts - a.ts;
  });
}

export async function loadClipboardHistory(): Promise<ClipboardHistoryEntry[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipboardHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return prune(parsed.map((e) => normalizeEntry(e)));
  } catch {
    return [];
  }
}

async function save(
  entries: ClipboardHistoryEntry[],
): Promise<ClipboardHistoryEntry[]> {
  const next = prune(entries);
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(next));
    return next;
  } catch {
    const slim = prune(next, Math.min(20, retentionMax));
    await SecureStore.setItemAsync(KEY, JSON.stringify(slim));
    return slim;
  }
}

export async function toggleClipboardHistoryPin(id: string): Promise<{
  entries: ClipboardHistoryEntry[];
  entry: ClipboardHistoryEntry | null;
}> {
  const prev = await loadClipboardHistory();
  let entry: ClipboardHistoryEntry | null = null;
  const next = prev.map((e) => {
    if (e.id !== id) return e;
    entry = { ...e, pinned: e.pinned ? undefined : true };
    return entry;
  });
  if (!entry) return { entries: prev, entry: null };
  return { entries: await save(next), entry };
}

export async function appendClipboardHistory(
  text: string,
  direction: ClipboardHistoryEntry["direction"],
  opts?: { kind?: "text" | "image"; imageUri?: string },
): Promise<{
  entries: ClipboardHistoryEntry[];
  entry: ClipboardHistoryEntry | null;
}> {
  const kind = opts?.kind ?? "text";
  const trimmed = text.trim();
  if (kind === "text" && !trimmed) {
    return { entries: await loadClipboardHistory(), entry: null };
  }

  const prev = await loadClipboardHistory();
  if (prev[0]?.text === trimmed && (prev[0]?.kind ?? "text") === kind) {
    return { entries: prev, entry: null };
  }

  const now = Date.now();
  const storedText =
    kind === "image" ? trimmed || "[Image]" : trimText(trimmed);
  const entry: ClipboardHistoryEntry = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: storedText,
    ts: now,
    updatedAt: now,
    direction,
    kind,
    imageUri: opts?.imageUri,
  };
  return { entries: await save([entry, ...prev]), entry };
}

/** Merge a peer text history row. Never touches the OS clipboard. */
export async function applyPeerHistoryUpsert(row: {
  id: string;
  text: string;
  updatedAt: number;
}): Promise<ClipboardHistoryEntry[]> {
  const text = trimText(row.text);
  if (!row.id || !text || !Number.isFinite(row.updatedAt)) {
    return loadClipboardHistory();
  }
  const prev = await loadClipboardHistory();
  const existingById = prev.find((e) => e.id === row.id);
  if (existingById && existingById.updatedAt > row.updatedAt) {
    return prev;
  }
  const sameText = prev.find(
    (e) => e.kind !== "image" && e.text === text && e.id !== row.id,
  );
  const pinned = existingById?.pinned || sameText?.pinned || undefined;
  const without = prev.filter(
    (e) => e.id !== row.id && !(e.kind !== "image" && e.text === text),
  );
  const entry: ClipboardHistoryEntry = {
    id: row.id,
    text,
    ts: row.updatedAt,
    updatedAt: row.updatedAt,
    direction: "in",
    kind: "text",
    pinned,
  };
  return save([entry, ...without]);
}

export async function applyPeerHistoryDelete(
  id: string,
  updatedAt: number,
): Promise<ClipboardHistoryEntry[]> {
  if (!id || !Number.isFinite(updatedAt)) return loadClipboardHistory();
  const prev = await loadClipboardHistory();
  const hit = prev.find((e) => e.id === id);
  if (hit && hit.updatedAt > updatedAt) return prev;
  return save(prev.filter((e) => e.id !== id));
}

export async function removeClipboardHistory(id: string): Promise<{
  entries: ClipboardHistoryEntry[];
  removed: ClipboardHistoryEntry | null;
}> {
  const prev = await loadClipboardHistory();
  const removed = prev.find((e) => e.id === id) ?? null;
  return { entries: await save(prev.filter((e) => e.id !== id)), removed };
}

export async function clearClipboardHistory(): Promise<
  ClipboardHistoryEntry[]
> {
  const prev = await loadClipboardHistory();
  await SecureStore.deleteItemAsync(KEY);
  return prev;
}

export async function listSharedClipboardHistory(): Promise<
  ClipboardHistoryEntry[]
> {
  return (await loadClipboardHistory())
    .filter((e) => (e.kind ?? "text") === "text")
    .slice(0, MAX_CLIPBOARD_HISTORY);
}
