/**
 * Termux allowlist bridge (v0.1 stubs).
 * Real execution uses Termux:API intents from a future native module /
 * RUN_COMMAND with an explicit allowlist. Free shell is never auto-run.
 */

export type TermuxAllowedCommand = "open-url" | "clipboard-set";

export function isTermuxAllowed(
  command: string,
): command is TermuxAllowedCommand {
  return command === "open-url" || command === "clipboard-set";
}

export type TermuxRequest =
  | { command: "open-url"; url: string }
  | { command: "clipboard-set"; text: string };

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
