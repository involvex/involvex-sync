/**
 * Short local outbox for share links and clipboard text when neither LAN nor
 * relay can deliver. Chunked files are never queued here.
 */

const KEY = "invx.outbox";
const MAX_ITEMS = 20;
const MAX_AGE_MS = 60 * 60_000;

export type OutboxKind = "share_url" | "clipboard";

export type OutboxItem = {
  id: string;
  peerId: string;
  kind: OutboxKind;
  text: string;
  createdAt: number;
};

function readAll(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OutboxItem[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.peerId === "string" &&
        (item.kind === "share_url" || item.kind === "clipboard") &&
        typeof item.text === "string" &&
        typeof item.createdAt === "number" &&
        now - item.createdAt <= MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}

function writeAll(items: OutboxItem[]): void {
  localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
}

export function enqueueOutbox(
  peerId: string,
  kind: OutboxKind,
  text: string,
): OutboxItem {
  const items = readAll().filter(
    (i) => !(i.peerId === peerId && i.kind === kind && i.text === text),
  );
  const item: OutboxItem = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    peerId,
    kind,
    text,
    createdAt: Date.now(),
  };
  items.push(item);
  writeAll(items);
  return item;
}

export function listOutbox(peerId?: string): OutboxItem[] {
  const items = readAll();
  return peerId ? items.filter((i) => i.peerId === peerId) : items;
}

export function removeOutboxItem(id: string): void {
  writeAll(readAll().filter((i) => i.id !== id));
}

export function clearOutboxForPeer(peerId: string): void {
  writeAll(readAll().filter((i) => i.peerId !== peerId));
}
