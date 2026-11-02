/**
 * Bridge to InVx Termux (`com.involvex.termux_app`) RUN_COMMAND API.
 *
 * Termux *defines* the dangerous permission on its package. Callers like
 * involvex Sync must declare `uses-permission` + package visibility and
 * request the permission at runtime before starting RunCommandService.
 */

export const TERMUX_PACKAGE = "com.involvex.termux_app";

export const TERMUX_RUN_COMMAND_PERMISSION =
  `${TERMUX_PACKAGE}.permission.RUN_COMMAND` as const;

export const TERMUX_RUN_COMMAND_ACTION =
  `${TERMUX_PACKAGE}.RUN_COMMAND` as const;

export const TERMUX_RUN_COMMAND_SERVICE =
  `${TERMUX_PACKAGE}.app.RunCommandService` as const;

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
} as const;

export type TermuxAllowedCommand = "open-url" | "clipboard-set";

export function isTermuxAllowed(
  command: string,
): command is TermuxAllowedCommand {
  return command === "open-url" || command === "clipboard-set";
}

export type TermuxRequest =
  | { command: "open-url"; url: string }
  | { command: "clipboard-set"; text: string };

export type TermuxRunCommandSpec = {
  /** Absolute path inside Termux, e.g. /data/data/.../files/usr/bin/termux-open-url */
  commandPath: string;
  arguments?: string[];
  workdir?: string;
  background?: boolean;
  label?: string;
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

/**
 * Allowlisted RUN_COMMAND specs. Paths assume a standard Termux prefix;
 * override with `files/usr` from Termux settings if needed.
 */
export function allowlistedRunSpec(req: TermuxRequest): TermuxRunCommandSpec {
  const usr = `/data/data/${TERMUX_PACKAGE}/files/usr`;
  switch (req.command) {
    case "open-url":
      return {
        commandPath: `${usr}/bin/termux-open-url`,
        arguments: [req.url],
        background: true,
        label: "involvex Sync open-url",
      };
    case "clipboard-set":
      return {
        commandPath: `${usr}/bin/termux-clipboard-set`,
        arguments: [req.text],
        background: true,
        label: "involvex Sync clipboard-set",
      };
  }
}
