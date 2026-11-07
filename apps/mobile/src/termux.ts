/**
 * Bridge to InVx Termux (`com.involvex.termux_app`) RUN_COMMAND API.
 *
 * Termux *defines* the dangerous permission on its package. Callers like
 * involvex Sync must declare `uses-permission` + package visibility and
 * request the permission at runtime before starting RunCommandService.
 *
 * Also required on the phone (Termux side):
 * 1. `~/.termux/termux.properties` → `allow-external-apps=true`
 * 2. For `termux-toast` / `termux-open-url`: `pkg install termux-api`
 *    (+ Termux:API companion app when using stock Termux API plugins)
 */

export const TERMUX_PACKAGE = "com.involvex.termux_app";

export const TERMUX_RUN_COMMAND_PERMISSION =
  `${TERMUX_PACKAGE}.permission.RUN_COMMAND` as const;

export const TERMUX_RUN_COMMAND_ACTION =
  `${TERMUX_PACKAGE}.RUN_COMMAND` as const;

export const TERMUX_RUN_COMMAND_SERVICE =
  `${TERMUX_PACKAGE}.app.RunCommandService` as const;

/**
 * Absolute Termux paths (InVx data dir). Prefer these over `$PREFIX` —
 * RunCommandService often rejects literal `$PREFIX` before shell expand.
 */
export const TERMUX_PREFIX = `/data/data/${TERMUX_PACKAGE}/files/usr`;
export const TERMUX_HOME = `/data/data/${TERMUX_PACKAGE}/files/home`;
export const TERMUX_BASH = `${TERMUX_PREFIX}/bin/bash`;

/** Intent extras (must match TermuxConstants.RUN_COMMAND_SERVICE). */
export const TermuxExtras = {
  COMMAND_PATH: `${TERMUX_PACKAGE}.RUN_COMMAND_PATH`,
  ARGUMENTS: `${TERMUX_PACKAGE}.RUN_COMMAND_ARGUMENTS`,
  STDIN: `${TERMUX_PACKAGE}.RUN_COMMAND_STDIN`,
  WORKDIR: `${TERMUX_PACKAGE}.RUN_COMMAND_WORKDIR`,
  BACKGROUND: `${TERMUX_PACKAGE}.RUN_COMMAND_BACKGROUND`,
  RUNNER: `${TERMUX_PACKAGE}.RUN_COMMAND_RUNNER`,
  SESSION_ACTION: `${TERMUX_PACKAGE}.RUN_COMMAND_SESSION_ACTION`,
  COMMAND_LABEL: `${TERMUX_PACKAGE}.RUN_COMMAND_COMMAND_LABEL`,
  PENDING_INTENT: `${TERMUX_PACKAGE}.RUN_COMMAND_PENDING_INTENT`,
} as const;

export const TERMUX_SETUP_HINT =
  "Termux needs allow-external-apps=true in ~/.termux/termux.properties. " +
  "termux-toast / termux-open-url need: pkg install termux-api";

export type TermuxAllowedCommand = "open-url" | "clipboard-set" | "shell";

export function isTermuxAllowed(
  command: string,
): command is TermuxAllowedCommand {
  return (
    command === "open-url" || command === "clipboard-set" || command === "shell"
  );
}

export type TermuxRequest =
  | { command: "open-url"; url: string }
  | { command: "clipboard-set"; text: string }
  | { command: "shell"; script: string };

export type TermuxRunCommandSpec = {
  /**
   * Absolute path preferred. `$PREFIX/...` / `~/...` are expanded in native
   * code to the Termux data dir.
   */
  commandPath: string;
  arguments?: string[];
  /** Defaults to Termux home. */
  workdir?: string;
  background?: boolean;
  label?: string;
  /** Optional stdin (e.g. pipe text into termux-clipboard-set). */
  stdin?: string;
  /** How long to wait for Termux PendingIntent result (ms). */
  timeoutMs?: number;
};

export type TermuxRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  errmsg: string;
  /** Package Sync actually addressed (always com.involvex.termux_app today). */
  termuxPackage?: string;
  /** Resolved absolute executable path sent to RUN_COMMAND. */
  commandPath?: string;
};

/**
 * Maps a protocol payload into a Termux allowlist request, or null.
 */
export function termuxRequestFromPayload(
  type: string,
  data: { url?: string; text?: string },
): TermuxRequest | null {
  if (type === "termux_open_url" && data.url) {
    return { command: "open-url", url: data.url };
  }
  if (type === "termux_clipboard_set" && typeof data.text === "string") {
    return { command: "clipboard-set", text: data.text };
  }
  return null;
}

/** Single-quote for embedding in `bash -c '…'`. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Allowlisted RUN_COMMAND specs.
 *
 * Shell/open-url follow InVx `termux-terminal-widget` CommandRunner:
 * absolute `sh` + command on stdin + background=true (most reliable).
 */
export function allowlistedRunSpec(req: TermuxRequest): TermuxRunCommandSpec {
  const sh = `${TERMUX_PREFIX}/bin/sh`;
  switch (req.command) {
    case "open-url":
      return {
        commandPath: sh,
        arguments: [],
        stdin: `exec termux-open-url ${shSingleQuote(req.url)}`,
        workdir: TERMUX_HOME,
        background: true,
        label: "involvex Sync open-url",
      };
    case "clipboard-set":
      return {
        // Prefer stdin: long clipboard text can break argv limits.
        commandPath: `${TERMUX_PREFIX}/bin/termux-clipboard-set`,
        arguments: [],
        stdin: req.text,
        workdir: TERMUX_HOME,
        background: true,
        label: "involvex Sync clipboard-set",
      };
    case "shell":
      return {
        commandPath: sh,
        arguments: [],
        stdin: req.script.slice(0, 2000),
        workdir: TERMUX_HOME,
        background: true,
        label: "involvex Sync remote shell",
      };
  }
}
