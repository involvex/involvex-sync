import * as SecureStore from "expo-secure-store";

const KEY = "invx.clipboard.history";
const MAX = 50;

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  ts: number;
  direction: "in" | "out" | "local";
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
): Promise<ClipboardHistoryEntry[]> {
  const trimmed = text.trim();
  if (!trimmed) return loadClipboardHistory();

  const prev = await loadClipboardHistory();
  if (prev[0]?.text === trimmed) {
    return prev;
  }

  // Keep entries short enough for SecureStore (~2KB limit on some devices).
  const storedText =
    trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
  const next: ClipboardHistoryEntry[] = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: storedText,
      ts: Date.now(),
      direction,
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

export async function clearClipboardHistory(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
