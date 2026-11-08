import {
  MAX_NOTES,
  MAX_NOTE_BODY_CHARS,
  MAX_NOTE_TITLE_CHARS,
} from "@involvex/protocol";
import * as FileSystem from "expo-file-system/legacy";

const FILE = `${FileSystem.documentDirectory ?? ""}invx-notes.json`;

export type SyncNote = {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  deleted?: boolean;
};

export type PendingNoteOp =
  | { op: "upsert"; note: SyncNote }
  | { op: "delete"; id: string; updatedAt: number };

type NotesFile = {
  notes: SyncNote[];
  pending: PendingNoteOp[];
};

async function readFile(): Promise<NotesFile> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return { notes: [], pending: [] };
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw) as NotesFile;
    return {
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return { notes: [], pending: [] };
  }
}

async function writeFile(data: NotesFile): Promise<void> {
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(data));
}

function sortNotes(notes: SyncNote[]): SyncNote[] {
  return [...notes]
    .filter((n) => !n.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_NOTES);
}

export async function loadNotes(): Promise<SyncNote[]> {
  const data = await readFile();
  return sortNotes(data.notes);
}

export async function loadPendingNoteOps(): Promise<PendingNoteOp[]> {
  const data = await readFile();
  return data.pending;
}

export function newNoteId(): string {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function upsertLocalNote(
  input: { id?: string; title: string; body: string },
  opts?: { fromPeer?: boolean; updatedAt?: number },
): Promise<{ notes: SyncNote[]; note: SyncNote; pending: PendingNoteOp[] }> {
  const data = await readFile();
  const updatedAt = opts?.updatedAt ?? Date.now();
  const id = input.id ?? newNoteId();
  const existing = data.notes.find((n) => n.id === id);
  if (existing && existing.updatedAt > updatedAt) {
    return {
      notes: sortNotes(data.notes),
      note: existing,
      pending: data.pending,
    };
  }
  const note: SyncNote = {
    id,
    title: input.title.trim().slice(0, MAX_NOTE_TITLE_CHARS),
    body: input.body.slice(0, MAX_NOTE_BODY_CHARS),
    updatedAt,
    deleted: false,
  };
  const notes = [note, ...data.notes.filter((n) => n.id !== id)].slice(
    0,
    MAX_NOTES * 2,
  );
  let pending = data.pending;
  if (!opts?.fromPeer) {
    pending = [
      ...pending.filter(
        (p) =>
          !(p.op === "upsert" && p.note.id === id) &&
          !(p.op === "delete" && p.id === id),
      ),
      { op: "upsert" as const, note },
    ];
  }
  const next = { notes, pending };
  await writeFile(next);
  return { notes: sortNotes(notes), note, pending };
}

export async function deleteLocalNote(
  id: string,
  opts?: { fromPeer?: boolean; updatedAt?: number },
): Promise<{ notes: SyncNote[]; pending: PendingNoteOp[] }> {
  const data = await readFile();
  const updatedAt = opts?.updatedAt ?? Date.now();
  const existing = data.notes.find((n) => n.id === id);
  if (existing && existing.updatedAt > updatedAt) {
    return { notes: sortNotes(data.notes), pending: data.pending };
  }
  const notes = data.notes.map((n) =>
    n.id === id ? { ...n, deleted: true, updatedAt } : n,
  );
  let pending = data.pending;
  if (!opts?.fromPeer) {
    pending = [
      ...pending.filter(
        (p) =>
          !(p.op === "upsert" && p.note.id === id) &&
          !(p.op === "delete" && p.id === id),
      ),
      { op: "delete" as const, id, updatedAt },
    ];
  }
  await writeFile({ notes, pending });
  return { notes: sortNotes(notes), pending };
}

export async function clearPendingNoteOps(
  keep: PendingNoteOp[],
): Promise<void> {
  const data = await readFile();
  await writeFile({ notes: data.notes, pending: keep });
}

export async function applyPeerNoteUpsert(note: SyncNote): Promise<SyncNote[]> {
  const { notes } = await upsertLocalNote(note, {
    fromPeer: true,
    updatedAt: note.updatedAt,
  });
  return notes;
}

export async function applyPeerNoteDelete(
  id: string,
  updatedAt: number,
): Promise<SyncNote[]> {
  const { notes } = await deleteLocalNote(id, { fromPeer: true, updatedAt });
  return notes;
}
