import { invoke } from "@tauri-apps/api/core";

/** How a device is attached — derived from the serial shape and `-l` props. */
export type AdbTransportKind = "usb" | "tcp" | "tls" | "emulator" | "other";

export type AdbDevice = {
  serial: string;
  /** `device`, `offline`, `unauthorized`, `no permissions`, … */
  state: string;
  model?: string;
  device?: string;
  product?: string;
  transportId?: string;
  /** Present for USB-attached devices (e.g. `2-3`). */
  usb?: string;
  transportKind: AdbTransportKind;
};

export type SerialReason =
  "ok" | "no-device" | "offline" | "unauthorized" | "ambiguous";

export type SerialResolution = {
  /** Serial to pass to adb (`-s`), or null when unresolved. */
  serial: string | null;
  reason: SerialReason;
  /** Stored hint was set but no longer usable (mDNS serials rotate). */
  staleSetting: boolean;
};

export type ResolveSerialOptions = {
  /** Persisted hint from settings (`adbSerial`). */
  preferred?: string;
  /** `ANDROID_SERIAL` from the environment. */
  envSerial?: string;
};

const TRANSPORT_LABEL: Record<AdbTransportKind, string> = {
  usb: "USB",
  tcp: "Wi-Fi",
  tls: "mDNS/TLS",
  emulator: "emulator",
  other: "?",
};

const TLS_SERIAL = /_adb-tls[-._]/i;
const TCP_SERIAL = /^\d{1,3}(\.\d{1,3}){3}:\d+$/;
const PROP_TOKEN = /^[A-Za-z0-9_.-]+:/;

/**
 * Parse `adb devices -l` stdout.
 *
 * The first line is the `List of devices attached` header, daemon progress
 * lines start with `*`, and every device line is
 * `<serial> <state...> [key:value …]`. The state may span multiple tokens
 * (`no permissions (user in plugdev group …)`), so tokens are collected until
 * the first `key:value` property.
 */
export function parseAdbDevices(raw: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("*")) continue;
    if (/^List of devices attached/i.test(trimmed)) continue;
    if (/^adb server/i.test(trimmed)) continue;

    const tokens = trimmed.split(/\s+/);
    const serial = tokens[0];
    if (!serial) continue;

    const stateTokens: string[] = [];
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      if (PROP_TOKEN.test(token)) {
        const idx = token.indexOf(":");
        props[token.slice(0, idx).toLowerCase()] = token.slice(idx + 1);
      } else {
        stateTokens.push(token);
      }
    }

    devices.push({
      serial,
      state: stateTokens.join(" ") || "unknown",
      model: props.model,
      device: props.device,
      product: props.product,
      transportId: props.transportid ?? props["transport_id"],
      usb: props.usb,
      transportKind: classifyTransport(serial, props),
    });
  }
  return devices;
}

function classifyTransport(
  serial: string,
  props: Record<string, string>,
): AdbTransportKind {
  if (serial.startsWith("emulator-")) return "emulator";
  if (TLS_SERIAL.test(serial)) return "tls";
  if (TCP_SERIAL.test(serial)) return "tcp";
  if (props.usb) return "usb";
  return "other";
}

/** Only fully-booted, authorized devices can be captured. */
export function isUsableForCapture(device: AdbDevice): boolean {
  return device.state === "device";
}

export function transportLabel(device: AdbDevice): string {
  return TRANSPORT_LABEL[device.transportKind];
}

/** Dropdown label: model/device name, transport, and state when unusable. */
export function deviceLabel(device: AdbDevice): string {
  const name = device.model ?? device.device ?? device.serial;
  const parts = [name, TRANSPORT_LABEL[device.transportKind]];
  if (!isUsableForCapture(device)) parts.push(device.state);
  return parts.join(" · ");
}

/**
 * Pick the serial for adb calls. Precedence:
 * stored setting → `ANDROID_SERIAL` → auto-pick when exactly one usable
 * device → otherwise no serial (caller shows the reason).
 *
 * A hint that no longer matches falls through to the next source instead of
 * failing — mDNS/TLS serials change whenever the phone reconnects.
 */
export function resolveSerial(
  devices: AdbDevice[],
  options: ResolveSerialOptions = {},
): SerialResolution {
  let staleSetting = false;

  for (const hint of [options.preferred, options.envSerial]) {
    const wanted = (hint ?? "").trim();
    if (!wanted) continue;
    const match = devices.find((d) => d.serial === wanted);
    if (match && isUsableForCapture(match)) {
      return { serial: match.serial, reason: "ok", staleSetting };
    }
    if (hint === options.preferred) staleSetting = true;
  }

  const usable = devices.filter(isUsableForCapture);
  if (usable.length === 1) {
    return { serial: usable[0].serial, reason: "ok", staleSetting };
  }
  if (usable.length > 1) {
    return { serial: null, reason: "ambiguous", staleSetting };
  }
  if (devices.length === 0) {
    return { serial: null, reason: "no-device", staleSetting };
  }
  const state = devices[0].state.toLowerCase();
  const unauthorized =
    state.includes("unauthorized") || state.includes("no permissions");
  return {
    serial: null,
    reason: unauthorized ? "unauthorized" : "offline",
    staleSetting,
  };
}

/** User-facing explanation for an unresolved serial. */
export function describeResolution(res: SerialResolution): string {
  switch (res.reason) {
    case "no-device":
      return "No adb device — connect USB or enable Wi-Fi debugging";
    case "unauthorized":
      return "Device not authorized — accept the USB debugging prompt on the phone";
    case "offline":
      return "Device offline — replug USB or reconnect Wi-Fi debugging";
    case "ambiguous":
      return "Multiple devices — pick one from the device list";
    default:
      return "";
  }
}

/** Extract a message from an unknown thrown value without `String(obj)`. */
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

/**
 * Turn an adb failure (invoke rejection string or stderr) into a message a
 * user can act on. adb's own wording is terse and often misleading.
 */
export function describeAdbError(err: unknown): string {
  const msg = errorText(err).trim() || "adb failed";
  const lower = msg.toLowerCase();

  if (lower.includes("spawn:") || lower.includes("not on path")) {
    return "adb not found on PATH — install Android platform-tools";
  }
  if (lower.includes("timeout")) {
    return "adb timed out — is the phone awake and unlocked?";
  }
  if (lower.includes("more than one device")) {
    return "Multiple adb devices — pick one from the device list";
  }
  if (lower.includes("no devices/emulators found")) {
    return "No adb device found — connect USB or enable Wi-Fi debugging";
  }
  if (lower.includes("device unauthorized")) {
    return "Device unauthorized — accept the USB debugging prompt on the phone";
  }
  if (
    lower.includes("device offline") ||
    lower.includes("error: device offline")
  ) {
    return "Device offline — replug USB or reconnect Wi-Fi debugging";
  }
  if (lower.includes("not a png")) {
    return "adb returned no image — the phone screen may be off";
  }
  if (lower.includes("closed")) {
    return "adb connection closed — replug the phone";
  }
  // Strip the "adb <subcommand>: " prefix adb adds, keep the rest.
  const stripped = msg.replace(/^adb [a-z-]+:\s*/i, "").trim();
  return stripped.slice(0, 200) || "adb failed";
}

/** Raw `adb devices -l` output, parsed. */
export function loadAdbDevices(timeoutMs = 10_000): Promise<AdbDevice[]> {
  return invoke<string>("adb_devices", { timeoutMs }).then(parseAdbDevices);
}
