import * as SecureStore from "expo-secure-store";

const KEY = "invx.clipboard.history";
const MAX = 50;

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  ts: number;
  direction: "in" | "out" | "local";
  kind?: "text" | "image";
  /** Local file URI for image entries (optional). */
  imageUri?: string;
};

export async function loadClipboardHistory(): Promise<ClipboardHistoryEntry[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipboardHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendClipboardHistory(
  text: string,
  direction: ClipboardHistoryEntry["direction"],
  opts?: { kind?: "text" | "image"; imageUri?: string },
): Promise<ClipboardHistoryEntry[]> {
  const kind = opts?.kind ?? "text";
  const trimmed = text.trim();
  if (kind === "text" && !trimmed) return loadClipboardHistory();

  const prev = await loadClipboardHistory();
  if (prev[0]?.text === trimmed && (prev[0]?.kind ?? "text") === kind) {
    return prev;
  }

  // Keep entries short enough for SecureStore (~2KB limit on some devices).
  const storedText =
    kind === "image"
      ? trimmed || "[Image]"
      : trimmed.length > 800
        ? `${trimmed.slice(0, 800)}…`
        : trimmed;
  const next: ClipboardHistoryEntry[] = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: storedText,
      ts: Date.now(),
      direction,
      kind,
      imageUri: opts?.imageUri,
    },
    ...prev,
  ].slice(0, MAX);

  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  } catch {
    // Fall back to fewer entries if store rejects the payload.
    const slim = next.slice(0, 20);
    await SecureStore.setItemAsync(KEY, JSON.stringify(slim));
    return slim;
  }
  return next;
}

export async function removeClipboardHistory(
  id: string,
): Promise<ClipboardHistoryEntry[]> {
  const next = (await loadClipboardHistory()).filter((e) => e.id !== id);
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  } catch {
    const slim = next.slice(0, 20);
    await SecureStore.setItemAsync(KEY, JSON.stringify(slim));
    return slim;
  }
  return next;
}

export async function clearClipboardHistory(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
