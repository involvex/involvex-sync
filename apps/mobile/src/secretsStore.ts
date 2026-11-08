import {
  MAX_SECRETS,
  MAX_SECRET_LABEL_CHARS,
  MAX_SECRET_VALUE_CHARS,
  generateVaultKeyHex,
  openVaultValue,
  sealVaultValue,
  type SecretKind,
} from "@involvex/protocol";
import * as FileSystem from "expo-file-system/legacy";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

const VAULT_KEY = "invx.vault.key";
const FILE = `${FileSystem.documentDirectory ?? ""}invx-secrets.json`;
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

async function readFile(): Promise<SecretsFile> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return { secrets: [], pending: [] };
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw) as SecretsFile;
    return {
      secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return { secrets: [], pending: [] };
  }
}

async function writeFile(data: SecretsFile): Promise<void> {
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(data));
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
  const raw = await SecureStore.getItemAsync(VAULT_KEY);
  return Boolean(raw);
}

async function authenticateBiometric(): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!hasHardware || !enrolled) {
    // No biometric — still allow unlock via SecureStore (device credential may prompt).
    return true;
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock Secrets",
    cancelLabel: "Cancel",
    disableDeviceFallback: false,
  });
  return result.success;
}

export async function unlockVault(): Promise<boolean> {
  if (isVaultUnlocked()) return true;
  const ok = await authenticateBiometric();
  if (!ok) return false;
  try {
    const keyHex = await SecureStore.getItemAsync(VAULT_KEY, {
      requireAuthentication: true,
      authenticationPrompt: "Unlock Secrets",
    });
    if (!keyHex) return false;
    touchUnlock(keyHex);
    return true;
  } catch {
    // Some devices reject requireAuthentication; fall back after biometric already passed.
    try {
      const keyHex = await SecureStore.getItemAsync(VAULT_KEY);
      if (!keyHex) return false;
      touchUnlock(keyHex);
      return true;
    } catch {
      return false;
    }
  }
}

export async function ensureVaultKey(): Promise<{
  keyHex: string;
  created: boolean;
}> {
  const existing = await SecureStore.getItemAsync(VAULT_KEY);
  if (existing) {
    touchUnlock(existing);
    return { keyHex: existing, created: false };
  }
  const ok = await authenticateBiometric();
  if (!ok) throw new Error("biometric required to create vault");
  const keyHex = generateVaultKeyHex();
  try {
    await SecureStore.setItemAsync(VAULT_KEY, keyHex, {
      requireAuthentication: true,
      authenticationPrompt: "Protect Secrets vault",
    });
  } catch {
    await SecureStore.setItemAsync(VAULT_KEY, keyHex);
  }
  touchUnlock(keyHex);
  return { keyHex, created: true };
}

export async function acceptSharedVaultKey(keyHex: string): Promise<void> {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("invalid vault key");
  const existing = await SecureStore.getItemAsync(VAULT_KEY);
  if (existing) return;
  try {
    await SecureStore.setItemAsync(VAULT_KEY, keyHex.toLowerCase(), {
      requireAuthentication: true,
      authenticationPrompt: "Protect Secrets vault",
    });
  } catch {
    await SecureStore.setItemAsync(VAULT_KEY, keyHex.toLowerCase());
  }
}

function requireUnlockedKey(): string {
  if (!isVaultUnlocked() || !unlockedKey) {
    throw new Error("vault locked");
  }
  return unlockedKey;
}

export async function loadSecrets(): Promise<StoredSecret[]> {
  const data = await readFile();
  return sortSecrets(data.secrets);
}

export async function loadPendingSecretOps(): Promise<PendingSecretOp[]> {
  const data = await readFile();
  return data.pending;
}

export function newSecretId(): string {
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function upsertLocalSecret(
  input: {
    id?: string;
    label: string;
    kind: SecretKind;
    value: string;
  },
  opts?: { fromPeer?: boolean; record?: StoredSecret },
): Promise<{
  secrets: StoredSecret[];
  secret: StoredSecret;
  pending: PendingSecretOp[];
}> {
  const data = await readFile();
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
    const existing = data.secrets.find((s) => s.id === id);
    const updatedAt = Date.now();
    if (existing && existing.updatedAt > updatedAt) {
      return {
        secrets: sortSecrets(data.secrets),
        secret: existing,
        pending: data.pending,
      };
    }
    secret = {
      id,
      label: input.label.trim().slice(0, MAX_SECRET_LABEL_CHARS) || "Secret",
      kind: input.kind,
      updatedAt,
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
  await writeFile({ secrets, pending });
  return { secrets: sortSecrets(secrets), secret, pending };
}

export async function deleteLocalSecret(
  id: string,
  opts?: { fromPeer?: boolean; updatedAt?: number },
): Promise<{ secrets: StoredSecret[]; pending: PendingSecretOp[] }> {
  const data = await readFile();
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
  await writeFile({ secrets, pending });
  return { secrets: sortSecrets(secrets), pending };
}

export function revealSecretValue(secret: StoredSecret): string {
  const keyHex = requireUnlockedKey();
  return openVaultValue(secret.ciphertext, secret.nonce, keyHex);
}

export async function queueVaultKeyShare(keyHex: string): Promise<void> {
  const data = await readFile();
  const pending = [
    ...data.pending.filter((p) => p.op !== "vault_key_share"),
    { op: "vault_key_share" as const, keyHex },
  ];
  await writeFile({ secrets: data.secrets, pending });
}

export async function clearPendingSecretOps(
  keep: PendingSecretOp[],
): Promise<void> {
  const data = await readFile();
  await writeFile({ secrets: data.secrets, pending: keep });
}

export async function applyPeerSecretUpsert(
  secret: StoredSecret,
): Promise<StoredSecret[]> {
  const { secrets } = await upsertLocalSecret(
    { label: secret.label, kind: secret.kind, value: "x" },
    { fromPeer: true, record: secret },
  );
  return secrets;
}

export async function applyPeerSecretDelete(
  id: string,
  updatedAt: number,
): Promise<StoredSecret[]> {
  const { secrets } = await deleteLocalSecret(id, {
    fromPeer: true,
    updatedAt,
  });
  return secrets;
}
