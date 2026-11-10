import { DEFAULT_PORT } from "@involvex/protocol";
import Constants from "expo-constants";

export type TransportMode = "lan" | "relay" | "myfritz";

export type TransportConfig = {
  mode: TransportMode;
  /** LAN host or myfritz hostname */
  host: string;
  port: number;
  relayUrl: string;
};

const defaultRelay =
  (Constants.expoConfig?.extra as { relayUrl?: string } | undefined)
    ?.relayUrl ?? "wss://sync.involvex.workers.dev/ws";

export function defaultTransport(host = ""): TransportConfig {
  return {
    mode: "lan",
    host,
    port: DEFAULT_PORT,
    relayUrl: defaultRelay,
  };
}

/**
 * Prefer LAN when a host is set. Relay is the away fallback.
 * MyFritz uses the same encrypted frames over ws:// to a forwarded port.
 */
export function resolveWsUrl(
  cfg: TransportConfig,
  deviceId: string,
  peerId?: string,
): string {
  if (cfg.mode === "relay") {
    const base = cfg.relayUrl.replace(/\/$/, "");
    const pair = peerId ? `${deviceId}:${peerId}` : deviceId;
    return `${base}?deviceId=${encodeURIComponent(pair)}&self=${encodeURIComponent(deviceId)}`;
  }

  const host = cfg.host.trim();
  if (!host) {
    throw new Error("host required for lan/myfritz");
  }
  const port = cfg.port || DEFAULT_PORT;
  return `ws://${host}:${port}`;
}
