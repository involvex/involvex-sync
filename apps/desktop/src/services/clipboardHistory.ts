import {
  MAX_CLIPBOARD_HISTORY,
  MAX_CLIPBOARD_HISTORY_TEXT_CHARS,
} from "@involvex/protocol";

const KEY = "invx.clipboard.history";
const DEFAULT_MAX = MAX_CLIPBOARD_HISTORY;

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  ts: number;
  /** Last write time for shared LWW merge (defaults to ts). */
  updatedAt: number;
  direction: "in" | "out" | "local";
  kind?: "text" | "image";
  /** Local path for image entries (optional). */
  imagePath?: string;
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
    imagePath: raw.imagePath,
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

export function loadClipboardHistory(): ClipboardHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipboardHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return prune(parsed.map((e) => normalizeEntry(e)));
  } catch {
    return [];
  }
}

function save(entries: ClipboardHistoryEntry[]): ClipboardHistoryEntry[] {
  const next = prune(entries);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

function trimText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_CLIPBOARD_HISTORY_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_CLIPBOARD_HISTORY_TEXT_CHARS)}…`
    : trimmed;
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

export function toggleClipboardHistoryPin(id: string): {
  entries: ClipboardHistoryEntry[];
  entry: ClipboardHistoryEntry | null;
} {
  const prev = loadClipboardHistory();
  let entry: ClipboardHistoryEntry | null = null;
  const next = prev.map((e) => {
    if (e.id !== id) return e;
    entry = { ...e, pinned: e.pinned ? undefined : true };
    return entry;
  });
  if (!entry) return { entries: prev, entry: null };
  return { entries: save(next), entry };
}

export function appendClipboardHistory(
  text: string,
  direction: ClipboardHistoryEntry["direction"],
  opts?: { kind?: "text" | "image"; imagePath?: string },
): { entries: ClipboardHistoryEntry[]; entry: ClipboardHistoryEntry | null } {
  const kind = opts?.kind ?? "text";
  const trimmed = text.trim();
  if (kind === "text" && !trimmed) {
    return { entries: loadClipboardHistory(), entry: null };
  }

  const prev = loadClipboardHistory();
  if (prev[0]?.text === trimmed && (prev[0]?.kind ?? "text") === kind) {
    return { entries: prev, entry: null };
  }

  const now = Date.now();
  const label = kind === "image" ? trimmed || "[Image]" : trimText(trimmed);
  const entry: ClipboardHistoryEntry = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: label,
    ts: now,
    updatedAt: now,
    direction,
    kind,
    imagePath: opts?.imagePath,
  };
  return { entries: save([entry, ...prev]), entry };
}

/** Merge a peer text history row. Never touches the OS clipboard. */
export function applyPeerHistoryUpsert(row: {
  id: string;
  text: string;
  updatedAt: number;
}): ClipboardHistoryEntry[] {
  const text = trimText(row.text);
  if (!row.id || !text || !Number.isFinite(row.updatedAt)) {
    return loadClipboardHistory();
  }
  const prev = loadClipboardHistory();
  const existingById = prev.find((e) => e.id === row.id);
  if (existingById && existingById.updatedAt > row.updatedAt) {
    return prev;
  }
  // Drop same-id and same-text duplicates (local clipboard_update append).
  // Preserve a local pin when the mesh replaces the same text/id.
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

export function applyPeerHistoryDelete(
  id: string,
  updatedAt: number,
): ClipboardHistoryEntry[] {
  if (!id || !Number.isFinite(updatedAt)) return loadClipboardHistory();
  const prev = loadClipboardHistory();
  const hit = prev.find((e) => e.id === id);
  if (hit && hit.updatedAt > updatedAt) return prev;
  return save(prev.filter((e) => e.id !== id));
}

export function removeClipboardHistory(id: string): {
  entries: ClipboardHistoryEntry[];
  removed: ClipboardHistoryEntry | null;
} {
  const prev = loadClipboardHistory();
  const removed = prev.find((e) => e.id === id) ?? null;
  return { entries: save(prev.filter((e) => e.id !== id)), removed };
}

export function clearClipboardHistory(): ClipboardHistoryEntry[] {
  const prev = loadClipboardHistory();
  localStorage.removeItem(KEY);
  return prev;
}

/** Text rows only — for mesh catch-up / fan-out (protocol soft cap). */
export function listSharedClipboardHistory(): ClipboardHistoryEntry[] {
  return loadClipboardHistory()
    .filter((e) => (e.kind ?? "text") === "text")
    .slice(0, MAX_CLIPBOARD_HISTORY);
}
