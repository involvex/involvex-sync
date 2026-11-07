const KEY = "invx.clipboard.history";
const MAX = 50;

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  ts: number;
  direction: "in" | "out" | "local";
  kind?: "text" | "image";
  /** Local path for image entries (optional). */
  imagePath?: string;
};

export function loadClipboardHistory(): ClipboardHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipboardHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendClipboardHistory(
  text: string,
  direction: ClipboardHistoryEntry["direction"],
  opts?: { kind?: "text" | "image"; imagePath?: string },
): ClipboardHistoryEntry[] {
  const kind = opts?.kind ?? "text";
  const trimmed = text.trim();
  if (kind === "text" && !trimmed) return loadClipboardHistory();

  const prev = loadClipboardHistory();
  if (prev[0]?.text === trimmed && (prev[0]?.kind ?? "text") === kind) {
    return prev;
  }
  const label =
    kind === "image"
      ? trimmed || "[Image]"
      : trimmed.length > 2000
        ? `${trimmed.slice(0, 2000)}…`
        : trimmed;
  const next: ClipboardHistoryEntry[] = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: label,
      ts: Date.now(),
      direction,
      kind,
      imagePath: opts?.imagePath,
    },
    ...prev,
  ].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearClipboardHistory(): void {
  localStorage.removeItem(KEY);
}
