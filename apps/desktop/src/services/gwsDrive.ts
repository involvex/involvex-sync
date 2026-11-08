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

function extractErrorHint(result: GwsCommandResult): string {
  const raw = `${result.stderr}\n${result.stdout}`.trim();
  if (!raw) {
    return result.exitCode === 2
      ? "auth error (exit 2)"
      : `gws failed (exit ${result.exitCode ?? "?"})`;
  }
  try {
    const json = JSON.parse(result.stdout) as {
      error?: { message?: string; code?: string };
    };
    if (json.error?.message) return json.error.message;
  } catch {
    /* not JSON */
  }
  const line = raw.split(/\r?\n/).find((l) => l.trim()) ?? raw;
  return line.slice(0, 240);
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
