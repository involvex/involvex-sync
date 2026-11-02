import * as SecureStore from "expo-secure-store";
import { DEFAULT_PORT } from "@involvex/protocol";
import { type TransportMode } from "./transport";

const KEY = "invx.mobile.transport";

export type TransportPrefs = {
  mode: TransportMode;
  host: string;
  port: number;
};

const defaults: TransportPrefs = {
  mode: "lan",
  host: "",
  port: DEFAULT_PORT,
};

function isMode(value: unknown): value is TransportMode {
  return value === "lan" || value === "relay" || value === "myfritz";
}

export async function loadTransportPrefs(): Promise<TransportPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<TransportPrefs>;
    return {
      mode: isMode(parsed.mode) ? parsed.mode : defaults.mode,
      host: typeof parsed.host === "string" ? parsed.host : defaults.host,
      port:
        typeof parsed.port === "number" && parsed.port > 0
          ? parsed.port
          : defaults.port,
    };
  } catch {
    return { ...defaults };
  }
}

export async function saveTransportPrefs(
  patch: Partial<TransportPrefs>,
): Promise<TransportPrefs> {
  const current = await loadTransportPrefs();
  const next: TransportPrefs = {
    mode: isMode(patch.mode) ? patch.mode : current.mode,
    host: typeof patch.host === "string" ? patch.host.trim() : current.host,
    port:
      typeof patch.port === "number" && patch.port > 0
        ? patch.port
        : current.port,
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next;
}
