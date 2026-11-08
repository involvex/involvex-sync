import {
  MAX_NOTES,
  MAX_NOTE_BODY_CHARS,
  MAX_NOTE_TITLE_CHARS,
} from "@involvex/protocol";

const KEY = "invx.notes";

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

function readFile(): NotesFile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { notes: [], pending: [] };
    const parsed = JSON.parse(raw) as NotesFile;
    return {
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return { notes: [], pending: [] };
  }
}

function writeFile(data: NotesFile): void {
  localStorage.setItem(KEY, JSON.stringify(data));
}

function sortNotes(notes: SyncNote[]): SyncNote[] {
  return [...notes]
    .filter((n) => !n.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_NOTES);
}

export function loadNotes(): SyncNote[] {
  return sortNotes(readFile().notes);
}

export function loadPendingNoteOps(): PendingNoteOp[] {
  return readFile().pending;
}

export function newNoteId(): string {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertLocalNote(
  input: { id?: string; title: string; body: string },
  opts?: { fromPeer?: boolean; updatedAt?: number },
): { notes: SyncNote[]; note: SyncNote; pending: PendingNoteOp[] } {
  const data = readFile();
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
  writeFile({ notes, pending });
  return { notes: sortNotes(notes), note, pending };
}

export function deleteLocalNote(
  id: string,
  opts?: { fromPeer?: boolean; updatedAt?: number },
): { notes: SyncNote[]; pending: PendingNoteOp[] } {
  const data = readFile();
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
  writeFile({ notes, pending });
  return { notes: sortNotes(notes), pending };
}

export function clearPendingNoteOps(keep: PendingNoteOp[]): void {
  const data = readFile();
  writeFile({ notes: data.notes, pending: keep });
}

export function applyPeerNoteUpsert(note: SyncNote): SyncNote[] {
  return upsertLocalNote(note, {
    fromPeer: true,
    updatedAt: note.updatedAt,
  }).notes;
}

export function applyPeerNoteDelete(id: string, updatedAt: number): SyncNote[] {
  return deleteLocalNote(id, { fromPeer: true, updatedAt }).notes;
}
