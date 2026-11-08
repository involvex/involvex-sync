import {
  MAX_SECRETS,
  MAX_SECRET_LABEL_CHARS,
  MAX_SECRET_VALUE_CHARS,
  generateVaultKeyHex,
  openVaultValue,
  sealVaultValue,
  type SecretKind,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";

const KEY = "invx.secrets";
const UNLOCK_TTL_MS = 5 * 60_000;

export type StoredSecret = {
  id: string;
  label: string;
  kind: SecretKind;
  updatedAt: number;
  nonce: string;
  ciphertext: string;
  deleted?: boolean;
};

export type PendingSecretOp =
  | { op: "upsert"; secret: StoredSecret }
  | { op: "delete"; id: string; updatedAt: number }
  | { op: "vault_key_share"; keyHex: string };

type SecretsFile = {
  secrets: StoredSecret[];
  pending: PendingSecretOp[];
};

let unlockedKey: string | null = null;
let unlockExpiresAt = 0;

function readFile(): SecretsFile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { secrets: [], pending: [] };
    const parsed = JSON.parse(raw) as SecretsFile;
    return {
      secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return { secrets: [], pending: [] };
  }
}

function writeFile(data: SecretsFile): void {
  localStorage.setItem(KEY, JSON.stringify(data));
}

function sortSecrets(secrets: StoredSecret[]): StoredSecret[] {
  return [...secrets]
    .filter((s) => !s.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SECRETS);
}

export function isVaultUnlocked(): boolean {
  if (!unlockedKey) return false;
  if (Date.now() > unlockExpiresAt) {
    unlockedKey = null;
    return false;
  }
  return true;
}

export function lockVault(): void {
  unlockedKey = null;
  unlockExpiresAt = 0;
}

function touchUnlock(keyHex: string): void {
  unlockedKey = keyHex;
  unlockExpiresAt = Date.now() + UNLOCK_TTL_MS;
}

export async function hasVaultKey(): Promise<boolean> {
  const key = await invoke<string | null>("load_vault_key");
  return Boolean(key);
}

export async function unlockVault(): Promise<boolean> {
  if (isVaultUnlocked()) return true;
  try {
    // OS-session gate: Windows Hello when available, else keyring read.
    await invoke<boolean>("confirm_vault_unlock");
    const keyHex = await invoke<string | null>("load_vault_key");
    if (!keyHex) return false;
    touchUnlock(keyHex);
    return true;
  } catch {
    return false;
  }
}

export async function ensureVaultKey(): Promise<{
  keyHex: string;
  created: boolean;
}> {
  const existing = await invoke<string | null>("load_vault_key");
  if (existing) {
    touchUnlock(existing);
    return { keyHex: existing, created: false };
  }
  await invoke<boolean>("confirm_vault_unlock");
  const keyHex = generateVaultKeyHex();
  await invoke("save_vault_key", { keyHex });
  touchUnlock(keyHex);
  return { keyHex, created: true };
}

export async function acceptSharedVaultKey(keyHex: string): Promise<void> {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("invalid vault key");
  const existing = await invoke<string | null>("load_vault_key");
  if (existing) return;
  await invoke("save_vault_key", { keyHex: keyHex.toLowerCase() });
}

function requireUnlockedKey(): string {
  if (!isVaultUnlocked() || !unlockedKey) {
    throw new Error("vault locked");
  }
  return unlockedKey;
}

export function loadSecrets(): StoredSecret[] {
  return sortSecrets(readFile().secrets);
}

export function loadPendingSecretOps(): PendingSecretOp[] {
  return readFile().pending;
}

export function newSecretId(): string {
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertLocalSecret(
  input: {
    id?: string;
    label: string;
    kind: SecretKind;
    value: string;
  },
  opts?: { fromPeer?: boolean; record?: StoredSecret },
): {
  secrets: StoredSecret[];
  secret: StoredSecret;
  pending: PendingSecretOp[];
} {
  const data = readFile();
  let secret: StoredSecret;
  if (opts?.record) {
    const existing = data.secrets.find((s) => s.id === opts.record!.id);
    if (existing && existing.updatedAt > opts.record.updatedAt) {
      return {
        secrets: sortSecrets(data.secrets),
        secret: existing,
        pending: data.pending,
      };
    }
    secret = { ...opts.record, deleted: false };
  } else {
    const keyHex = requireUnlockedKey();
    const value = input.value.slice(0, MAX_SECRET_VALUE_CHARS);
    if (!value.trim()) throw new Error("empty secret");
    const sealed = sealVaultValue(value, keyHex);
    const id = input.id ?? newSecretId();
    secret = {
      id,
      label: input.label.trim().slice(0, MAX_SECRET_LABEL_CHARS) || "Secret",
      kind: input.kind,
      updatedAt: Date.now(),
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      deleted: false,
    };
  }
  const secrets = [
    secret,
    ...data.secrets.filter((s) => s.id !== secret.id),
  ].slice(0, MAX_SECRETS * 2);
  let pending = data.pending;
  if (!opts?.fromPeer) {
    pending = [
      ...pending.filter(
        (p) =>
          !(p.op === "upsert" && p.secret.id === secret.id) &&
          !(p.op === "delete" && p.id === secret.id),
      ),
      { op: "upsert" as const, secret },
    ];
  }
  writeFile({ secrets, pending });
  return { secrets: sortSecrets(secrets), secret, pending };
}

export function deleteLocalSecret(
  id: string,
  opts?: { fromPeer?: boolean; updatedAt?: number },
): { secrets: StoredSecret[]; pending: PendingSecretOp[] } {
  const data = readFile();
  const updatedAt = opts?.updatedAt ?? Date.now();
  const existing = data.secrets.find((s) => s.id === id);
  if (existing && existing.updatedAt > updatedAt) {
    return { secrets: sortSecrets(data.secrets), pending: data.pending };
  }
  const secrets = data.secrets.map((s) =>
    s.id === id ? { ...s, deleted: true, updatedAt } : s,
  );
  let pending = data.pending;
  if (!opts?.fromPeer) {
    pending = [
      ...pending.filter(
        (p) =>
          !(p.op === "upsert" && p.secret.id === id) &&
          !(p.op === "delete" && p.id === id),
      ),
      { op: "delete" as const, id, updatedAt },
    ];
  }
  writeFile({ secrets, pending });
  return { secrets: sortSecrets(secrets), pending };
}

export function revealSecretValue(secret: StoredSecret): string {
  const keyHex = requireUnlockedKey();
  return openVaultValue(secret.ciphertext, secret.nonce, keyHex);
}

export function queueVaultKeyShare(keyHex: string): void {
  const data = readFile();
  const pending = [
    ...data.pending.filter((p) => p.op !== "vault_key_share"),
    { op: "vault_key_share" as const, keyHex },
  ];
  writeFile({ secrets: data.secrets, pending });
}

export function clearPendingSecretOps(keep: PendingSecretOp[]): void {
  const data = readFile();
  writeFile({ secrets: data.secrets, pending: keep });
}

export function applyPeerSecretUpsert(secret: StoredSecret): StoredSecret[] {
  return upsertLocalSecret(
    { label: secret.label, kind: secret.kind, value: "x" },
    { fromPeer: true, record: secret },
  ).secrets;
}

export function applyPeerSecretDelete(
  id: string,
  updatedAt: number,
): StoredSecret[] {
  return deleteLocalSecret(id, { fromPeer: true, updatedAt }).secrets;
}
