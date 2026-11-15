import type { SecretKind } from "@involvex/protocol";
import type { SyncNote } from "../services/notesStore";
import type { StoredSecret } from "../services/secretsStore";

export type NotesVaultPanelProps = {
  live: boolean;
  notes: SyncNote[];
  noteTitle: string;
  noteBody: string;
  editingNoteId: string | undefined;
  onNoteTitle: (value: string) => void;
  onNoteBody: (value: string) => void;
  onSaveNote: () => void;
  onCancelEdit: () => void;
  onEditNote: (note: SyncNote) => void;
  onDeleteNote: (note: SyncNote) => void;
  vaultUnlocked: boolean;
  secrets: StoredSecret[];
  secretLabel: string;
  secretKind: SecretKind;
  secretValue: string;
  revealedSecrets: Record<string, string>;
  onSecretLabel: (value: string) => void;
  onSecretKind: (value: SecretKind) => void;
  onSecretValue: (value: string) => void;
  onLockVault: () => void;
  onUnlockVault: () => void;
  onEnableVault: () => void;
  onSaveSecret: () => void;
  onRevealSecret: (secret: StoredSecret) => void;
  onCopySecret: (secretId: string) => void;
  onDeleteSecret: (secret: StoredSecret) => void;
};

/** Notes + vault secrets — shared state that fans out to every connected host. */
export function NotesVaultPanel(props: NotesVaultPanelProps) {
  const {
    live,
    notes,
    noteTitle,
    noteBody,
    editingNoteId,
    onNoteTitle,
    onNoteBody,
    onSaveNote,
    onCancelEdit,
    onEditNote,
    onDeleteNote,
    vaultUnlocked,
    secrets,
    secretLabel,
    secretKind,
    secretValue,
    revealedSecrets,
    onSecretLabel,
    onSecretKind,
    onSecretValue,
    onLockVault,
    onUnlockVault,
    onEnableVault,
    onSaveSecret,
    onRevealSecret,
    onCopySecret,
    onDeleteSecret,
  } = props;

  return (
    <article className="card">
      <h2>Notes</h2>
      <p className="muted small">
        Quick notes sync to every connected host
        {live ? "." : " (offline — queued)."}
      </p>
      <label className="stack">
        Title
        <input
          value={noteTitle}
          onChange={(e) => onNoteTitle(e.target.value)}
          placeholder="Untitled"
        />
      </label>
      <label className="stack">
        Note
        <textarea
          rows={3}
          value={noteBody}
          onChange={(e) => onNoteBody(e.target.value)}
          placeholder="Write a quick note…"
        />
      </label>
      <div className="row">
        <button type="button" onClick={onSaveNote}>
          {editingNoteId ? "Update note" : "Save note"}
        </button>
        {editingNoteId ? (
          <button type="button" className="ghost" onClick={onCancelEdit}>
            Cancel
          </button>
        ) : null}
      </div>
      <ul className="history">
        {notes.map((n) => (
          <li key={n.id}>
            <strong>{n.title}</strong>
            <p className="muted small">{n.body || "(empty)"}</p>
            <div className="row">
              <button
                type="button"
                className="ghost"
                onClick={() => onEditNote(n)}
              >
                Edit
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => onDeleteNote(n)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {notes.length === 0 ? <p className="muted small">No notes yet.</p> : null}

      <hr className="divider" />
      <h2>Secrets</h2>
      <p className="muted small">
        API keys / passwords encrypted at rest. Unlock uses Windows Credential
        Manager (signed-in user). Ciphertext syncs to every connected host.
      </p>
      <div className="row">
        {vaultUnlocked ? (
          <button type="button" className="ghost" onClick={onLockVault}>
            Lock
          </button>
        ) : (
          <button type="button" onClick={onUnlockVault}>
            Unlock
          </button>
        )}
        <button type="button" className="ghost" onClick={onEnableVault}>
          Enable vault
        </button>
      </div>
      {vaultUnlocked ? (
        <>
          <label className="stack">
            Label
            <input
              value={secretLabel}
              onChange={(e) => onSecretLabel(e.target.value)}
              placeholder="OpenAI / GitHub token"
            />
          </label>
          <label className="stack">
            Kind
            <select
              value={secretKind}
              onChange={(e) => onSecretKind(e.target.value as SecretKind)}
            >
              <option value="api_key">api_key</option>
              <option value="password">password</option>
              <option value="token">token</option>
              <option value="text">text</option>
            </select>
          </label>
          <label className="stack">
            Value
            <input
              type="password"
              value={secretValue}
              onChange={(e) => onSecretValue(e.target.value)}
              placeholder="••••••••"
              autoComplete="off"
            />
          </label>
          <div className="row">
            <button type="button" onClick={onSaveSecret}>
              Save secret
            </button>
          </div>
        </>
      ) : (
        <p className="muted small">
          Unlock to add or reveal values. Labels stay visible while locked.
        </p>
      )}
      <ul className="history">
        {secrets.map((sec) => (
          <li key={sec.id}>
            <strong>
              {sec.label} · {sec.kind}
            </strong>
            <p className="muted small mono">
              {revealedSecrets[sec.id] ?? "••••••••"}
            </p>
            <div className="row">
              <button
                type="button"
                className="ghost"
                onClick={() => onRevealSecret(sec)}
              >
                Reveal
              </button>
              {revealedSecrets[sec.id] ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onCopySecret(sec.id)}
                >
                  Copy
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                onClick={() => onDeleteSecret(sec)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {secrets.length === 0 ? (
        <p className="muted small">No secrets yet.</p>
      ) : null}
    </article>
  );
}
