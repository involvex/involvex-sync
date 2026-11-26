import {
  MAX_CLIPBOARD_HISTORY,
  MAX_CLIPBOARD_HISTORY_TEXT_CHARS,
} from "@involvex/protocol";
import * as SecureStore from "expo-secure-store";

const KEY = "invx.clipboard.history";
const MAX = MAX_CLIPBOARD_HISTORY;
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
};

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
  };
}

function trimText(text: string, max = STORE_TEXT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export async function loadClipboardHistory(): Promise<ClipboardHistoryEntry[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipboardHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e) => normalizeEntry(e)).slice(0, MAX);
  } catch {
    return [];
  }
}

async function save(
  entries: ClipboardHistoryEntry[],
): Promise<ClipboardHistoryEntry[]> {
  const next = entries
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || b.ts - a.ts)
    .slice(0, MAX);
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(next));
    return next;
  } catch {
    const slim = next.slice(0, 20);
    await SecureStore.setItemAsync(KEY, JSON.stringify(slim));
    return slim;
  }
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
  const existing = prev.find((e) => e.id === row.id);
  if (existing && existing.updatedAt > row.updatedAt) {
    return prev;
  }
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
  return (await loadClipboardHistory()).filter(
    (e) => (e.kind ?? "text") === "text",
  );
}
