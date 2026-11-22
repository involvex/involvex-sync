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

/** LAN / MyFritz cleartext WebSocket URL. */
export function resolveLanWsUrl(cfg: TransportConfig): string {
  const host = cfg.host.trim();
  if (!host) {
    throw new Error("host required for lan/myfritz");
  }
  const port = cfg.port || DEFAULT_PORT;
  return `ws://${host}:${port}`;
}

/** Cloudflare relay room URL for this local/peer pair. */
export function resolveRelayWsUrl(
  cfg: TransportConfig,
  deviceId: string,
  peerId?: string,
): string {
  const base = cfg.relayUrl.replace(/\/$/, "") || defaultRelay;
  const pair = peerId ? `${deviceId}:${peerId}` : deviceId;
  return `${base}?deviceId=${encodeURIComponent(pair)}&self=${encodeURIComponent(deviceId)}`;
}

/**
 * Resolve the WebSocket URL for a dial attempt.
 * - `relay` mode: always the Cloudflare room
 * - `myfritz` mode: always the forwarded host (no auto relay)
 * - `lan` mode: LAN when a host is set; callers may fall back to relay
 */
export function resolveWsUrl(
  cfg: TransportConfig,
  deviceId: string,
  peerId?: string,
  path: "lan" | "relay" = cfg.mode === "relay" ? "relay" : "lan",
): string {
  if (cfg.mode === "relay" || path === "relay") {
    return resolveRelayWsUrl(cfg, deviceId, peerId);
  }
  return resolveLanWsUrl(cfg);
}
