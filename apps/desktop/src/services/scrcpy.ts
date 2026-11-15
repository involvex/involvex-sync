/** Build/validate argv for local scrcpy / Escrcpy launches (Commands tab). */

/** Same allowlist as Escrcpy `assertSafeSerial` / Rust `assert_safe_serial`. */
const SERIAL_PATTERN = /^[\w.:[\]-]+$/;

/** Reject shell metacharacters in extra flags (defense in depth; Rust also checks). */
const UNSAFE_ARG = /[;|&<>`$'\n\r]/;

export type MirrorLaunchArgs = {
  serial: string;
  /** Extra scrcpy CLI flags (already split). */
  extraArgs?: string[];
};

export function assertSafeSerial(serial: string): string {
  const s = serial.trim();
  if (!s) throw new Error("empty serial");
  if (s.length > 128) throw new Error("serial too long");
  if (!SERIAL_PATTERN.test(s)) throw new Error("unsafe serial rejected");
  return s;
}

export function assertSafeScrcpyArg(arg: string): string {
  const a = arg.trim();
  if (!a) throw new Error("empty scrcpy arg");
  if (a.length > 512) throw new Error("scrcpy arg too long");
  if (UNSAFE_ARG.test(a) || a.includes("\0")) {
    throw new Error("unsafe scrcpy arg rejected");
  }
  return a;
}

/**
 * Parse a free-form extra-args string into argv tokens.
 * Supports simple quotes (`"..."` / `'...'`) and whitespace splitting.
 */
export function parseScrcpyExtraArgs(raw: string): string[] {
  const out: string[] = [];
  const s = raw.trim();
  if (!s) return out;

  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    if (i >= s.length) break;
    const quoteChar = s.charAt(i);
    const quote = quoteChar === '"' || quoteChar === "'" ? quoteChar : null;
    if (quote) {
      i++;
      let token = "";
      while (i < s.length && s.charAt(i) !== quote) {
        token += s.charAt(i);
        i++;
      }
      if (i < s.length) i++; // closing quote
      out.push(assertSafeScrcpyArg(token));
      continue;
    }
    const start = i;
    while (i < s.length && !/\s/.test(s.charAt(i))) i++;
    out.push(assertSafeScrcpyArg(s.slice(start, i)));
  }
  if (out.length > 32) throw new Error("too many scrcpy args");
  return out;
}

/** Argv for `scrcpy` (not including the program path). */
export function buildScrcpyArgs(input: MirrorLaunchArgs): string[] {
  const serial = assertSafeSerial(input.serial);
  const extra = (input.extraArgs ?? []).map(assertSafeScrcpyArg);
  if (extra.length > 32) throw new Error("too many scrcpy args");
  return ["-s", serial, ...extra];
}

/** Argv for `escrcpy mirror` (not including the program path). */
export function buildEsrcpyMirrorArgs(input: MirrorLaunchArgs): string[] {
  const serial = assertSafeSerial(input.serial);
  const extra = (input.extraArgs ?? []).map(assertSafeScrcpyArg);
  if (extra.length > 32) throw new Error("too many scrcpy args");
  return ["mirror", serial, ...extra];
}

/** Escrcpy GUI second-instance / launch flag. */
export function buildEsrcpyGuiArgs(serial: string): string[] {
  return [`--device-id=${assertSafeSerial(serial)}`];
}

export type MirrorBins = {
  scrcpy: string | null;
  escrcpy: string | null;
};

export type ScrcpyStatus = {
  running: boolean;
  pid: number | null;
};

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  if (err == null) return "";
  try {
    return JSON.stringify(err) ?? "";
  } catch {
    return "";
  }
}

/** Map spawn/path errors to actionable copy (mirrors describeAdbError tone). */
export function describeMirrorError(err: unknown): string {
  const msg = errorText(err);
  const lower = (msg || "mirror failed").toLowerCase();
  if (
    lower.includes("scrcpy not found") ||
    lower.includes("escrcpy.exe not found")
  ) {
    return msg.trim().slice(0, 240) || "scrcpy / Escrcpy not found";
  }
  if (lower.includes("already running")) {
    return "Mirror already running — stop it first";
  }
  if (lower.includes("unsafe serial")) {
    return "Invalid device serial";
  }
  if (lower.includes("spawn")) {
    return "Could not start mirror — check scrcpy / Escrcpy path in Settings";
  }
  return (msg.trim() || "mirror failed").slice(0, 200);
}
