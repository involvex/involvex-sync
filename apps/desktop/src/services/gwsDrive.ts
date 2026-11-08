import { invoke } from "@tauri-apps/api/core";

export type GwsCommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type GwsProbeStatus =
  | { status: "ok"; detail: string }
  | { status: "missing"; detail: string }
  | { status: "auth"; detail: string }
  | { status: "error"; detail: string };

async function runGws(
  args: string[],
  timeoutMs = 120_000,
): Promise<GwsCommandResult> {
  return invoke<GwsCommandResult>("run_gws", { args, timeoutMs });
}

/** `gws` always logs its keyring backend to stderr; never surface that as an error. */
const KEYRING_NOISE = /using keyring backend:/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function errorLines(raw: string): string[] {
  return raw
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !KEYRING_NOISE.test(l));
}

export function extractErrorHint(result: GwsCommandResult): string {
  try {
    const json = JSON.parse(result.stdout) as {
      error?: { message?: string; code?: string };
    };
    if (json.error?.message) return json.error.message;
  } catch {
    /* not JSON */
  }
  const lines = errorLines(`${result.stderr}\n${result.stdout}`);
  if (lines.length === 0) {
    return result.exitCode === 2
      ? "auth error (exit 2)"
      : `gws failed (exit ${result.exitCode ?? "?"})`;
  }
  return lines[0].slice(0, 240);
}

function parseFileId(stdout: string): string | undefined {
  try {
    const json = JSON.parse(stdout) as { id?: string; fileId?: string };
    if (typeof json.id === "string" && json.id) return json.id;
    if (typeof json.fileId === "string" && json.fileId) return json.fileId;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Check gws binary + Drive auth (`drive about get`). */
export async function probeGws(): Promise<GwsProbeStatus> {
  try {
    const result = await runGws(
      ["drive", "about", "get", "--params", '{"fields":"user,storageQuota"}'],
      30_000,
    );
    if (result.ok) {
      return { status: "ok", detail: "Drive API reachable via gws" };
    }
    if (result.exitCode === 2) {
      return {
        status: "auth",
        detail: extractErrorHint(result) || "run: gws auth login -s drive",
      };
    }
    const hint = extractErrorHint(result);
    if (
      /not found|PATH|spawn/i.test(hint) ||
      /not found|PATH|spawn/i.test(result.stderr)
    ) {
      return { status: "missing", detail: hint };
    }
    return { status: "error", detail: hint };
  } catch (e) {
    const msg = String(e);
    if (/not found|PATH|spawn/i.test(msg)) {
      return { status: "missing", detail: msg };
    }
    return { status: "error", detail: msg };
  }
}

export type DriveUploadResult = {
  ok: boolean;
  fileId?: string;
  detail: string;
};

/**
 * Upload a local file with `gws drive +upload`.
 * Empty parentId uploads to My Drive root.
 */
export async function uploadFileToDrive(opts: {
  path: string;
  name: string;
  parentId?: string;
  timeoutMs?: number;
}): Promise<DriveUploadResult> {
  const args = ["drive", "+upload", opts.path, "--name", opts.name];
  const parent = opts.parentId?.trim();
  if (parent) {
    args.push("--parent", parent);
  }
  try {
    const result = await runGws(args, opts.timeoutMs ?? 180_000);
    if (!result.ok) {
      return {
        ok: false,
        detail: extractErrorHint(result),
      };
    }
    return {
      ok: true,
      fileId: parseFileId(result.stdout),
      detail: result.stdout.slice(0, 200) || "uploaded",
    };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/* ------------------------------------------------------------------ *
 * Read-only Drive browsing (`gws drive files list`)
 * ------------------------------------------------------------------ */

/** Drive folder/file ids are opaque, but always url-safe base64-ish. */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

const DRIVE_LIST_FIELDS =
  "files(id,name,mimeType,size,modifiedTime),nextPageToken";

export const DRIVE_PAGE_SIZE_DEFAULT = 50;
/**
 * Upper bound stays well under the Rust JSON capture cap (256 KiB) so a page
 * can never be truncated mid-JSON.
 */
export const DRIVE_PAGE_SIZE_MAX = 200;

export type DriveFileEntry = {
  id: string;
  name: string;
  mimeType: string;
  /** Byte size; absent for Google-native docs (no binary size). */
  size?: number;
  /** RFC 3339 timestamp from the Drive API. */
  modifiedTime?: string;
  parents?: string[];
};

export type DriveListParams = {
  /** Folder to list. Empty/undefined = My Drive root. */
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
};

export type DriveListOk = {
  ok: true;
  files: DriveFileEntry[];
  nextPageToken?: string;
};

export type DriveListResult = DriveListOk | { ok: false; detail: string };

export class DriveQueryError extends Error {}

function driveIdOrThrow(value: string, label: string): string {
  const id = value.trim();
  if (!DRIVE_ID_RE.test(id)) {
    throw new DriveQueryError(`invalid ${label}`);
  }
  return id;
}

/**
 * Accept a bare Drive folder id or a pasted Drive URL
 * (`https://drive.google.com/drive/folders/<id>?usp=sharing`) and return the id.
 * Returns "" when the input is empty or is not a usable folder id.
 */
export function normalizeDriveFolderId(input: string): string {
  const raw = input.trim();
  if (raw === "") return "";
  if (DRIVE_ID_RE.test(raw)) return raw;
  const fromPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(raw);
  if (fromPath) return fromPath[1];
  const fromQuery = /[?&]id=([A-Za-z0-9_-]+)/.exec(raw);
  if (fromQuery) return fromQuery[1];
  return "";
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DRIVE_PAGE_SIZE_DEFAULT;
  }
  const n = Math.trunc(value);
  return Math.min(DRIVE_PAGE_SIZE_MAX, Math.max(1, n));
}

/**
 * Build the `--params` JSON for `drive files list`.
 *
 * My-Drive-only: the root page lists `'root' in parents`, not `trashed = false`
 * (which would return every file at every depth, flattened).
 * Throws DriveQueryError when the folder id would break the Drive `q` string.
 */
export function buildListParams(opts: DriveListParams = {}): string {
  const params: Record<string, unknown> = {
    pageSize: clampPageSize(opts.pageSize),
    fields: DRIVE_LIST_FIELDS,
    orderBy:
      (opts.orderBy ?? "modifiedTime desc").trim() || "modifiedTime desc",
    q: "'root' in parents and trashed = false",
  };
  const folderId = opts.folderId?.trim();
  if (folderId) {
    params.q = `'${driveIdOrThrow(folderId, "Drive folder id")}' in parents and trashed = false`;
  }
  const pageToken = opts.pageToken?.trim();
  if (pageToken) params.pageToken = pageToken;
  return JSON.stringify(params);
}

function parseDriveSize(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseDriveFile(raw: unknown): DriveFileEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  const size = parseDriveSize(obj.size);
  const entry: DriveFileEntry = {
    id: obj.id,
    name: typeof obj.name === "string" && obj.name ? obj.name : obj.id,
    mimeType:
      typeof obj.mimeType === "string"
        ? obj.mimeType
        : "application/octet-stream",
    ...(size !== undefined ? { size } : {}),
    ...(typeof obj.modifiedTime === "string"
      ? { modifiedTime: obj.modifiedTime }
      : {}),
    ...(isStringArray(obj.parents) ? { parents: obj.parents } : {}),
  };
  return entry;
}

/** Parse `drive files list --format json` stdout. Returns null when unparseable. */
export function parseDriveList(
  stdout: string,
): { files: DriveFileEntry[]; nextPageToken?: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.files)) return null;
  const files = obj.files
    .map(parseDriveFile)
    .filter((f): f is DriveFileEntry => f !== null);
  const next =
    typeof obj.nextPageToken === "string" && obj.nextPageToken
      ? obj.nextPageToken
      : undefined;
  return { files, ...(next ? { nextPageToken: next } : {}) };
}

/**
 * List one page of Drive files (read-only, My Drive).
 * Each call spawns one `gws` process; keep it to explicit user actions.
 */
export async function listDriveFiles(
  opts: DriveListParams & { timeoutMs?: number } = {},
): Promise<DriveListResult> {
  let params: string;
  try {
    params = buildListParams(opts);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    const result = await runGws(
      ["drive", "files", "list", "--params", params, "--format", "json"],
      opts.timeoutMs ?? 45_000,
    );
    if (!result.ok) {
      return { ok: false, detail: extractErrorHint(result) };
    }
    const parsed = parseDriveList(result.stdout);
    if (!parsed) {
      return {
        ok: false,
        detail: result.stdout.endsWith("…")
          ? "gws output was truncated — try a smaller page"
          : "unexpected gws output (not JSON)",
      };
    }
    return { ok: true, ...parsed };
  } catch (e) {
    const msg = String(e);
    if (/not found|PATH|spawn/i.test(msg)) {
      return { ok: false, detail: "gws not found on PATH" };
    }
    return { ok: false, detail: msg };
  }
}

/** Web URL for a Drive file, or undefined when the id is not a Drive id. */
export function driveFileUrl(fileId: string): string | undefined {
  const id = fileId.trim();
  if (!DRIVE_ID_RE.test(id)) return undefined;
  return `https://drive.google.com/open?id=${encodeURIComponent(id)}`;
}

/** Open a Drive file in the default browser (routed through the URL allowlist). */
export async function openDriveFile(fileId: string): Promise<void> {
  const url = driveFileUrl(fileId);
  if (!url) throw new Error("invalid Drive file id");
  await invoke("open_allowed_url", { url });
}

/** Human-readable byte size; em dash for unknown (Google-native files). */
export function formatDriveSize(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Local timestamp for a Drive RFC 3339 `modifiedTime`; em dash when unknown. */
export function formatDriveTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}
