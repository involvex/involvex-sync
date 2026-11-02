import {
  DEFAULT_PORT,
  buildPairingPayload,
  deviceFingerprint,
  encryptFrame,
  pairingQrText,
  parseAllowedUrl,
  parsePairingQr,
  serializeFrame,
  shareUrlBody,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable as enableAutostart } from "@tauri-apps/plugin-autostart";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type StoredDeviceKeys,
  type StoredPeer,
  clearPeer,
  ensureLocalIdentity,
  loadPeer,
  savePeer,
  toDeviceKeys,
} from "./services/identity";
import { RelayClient } from "./services/relay";
import { SyncSession } from "./services/session";
import "./App.css";

type LanInfo = {
  ip: string | null;
  port: number;
  status: {
    listening: boolean;
    port: number;
    peerConnected: boolean;
    peerAddr: string | null;
  };
};

export default function App() {
  const [identity, setIdentity] = useState<StoredDeviceKeys | null>(null);
  const [peer, setPeer] = useState<StoredPeer | null>(null);
  const [lan, setLan] = useState<LanInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [pairPaste, setPairPaste] = useState("");
  const [sendUrl, setSendUrl] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [firewallMsg, setFirewallMsg] = useState<string>("");
  const [relayStatus, setRelayStatus] = useState<string>("off");
  const [relay, setRelay] = useState<RelayClient | null>(null);

  const log = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${stamp}] ${line}`, ...prev].slice(0, 80));
  }, []);

  const session = useMemo(() => {
    if (!identity) return null;
    return new SyncSession(identity, {
      onShareUrl: async (url) => {
        await invoke("open_allowed_url", { url });
        log(`opened ${url}`);
      },
      onClipboard: async (text) => {
        await writeText(text);
        log("clipboard updated from peer");
      },
      onLog: log,
    });
  }, [identity, log]);

  useEffect(() => {
    if (session && peer) session.setPeer(peer);
  }, [session, peer]);

  useEffect(() => {
    void (async () => {
      const id = await ensureLocalIdentity("Windows-PC");
      setIdentity(id);
      const storedPeer = await loadPeer();
      setPeer(storedPeer);
      const info = await invoke<LanInfo>("get_lan_info");
      setLan(info);
      try {
        const mdns = await invoke<string>("start_mdns", {
          deviceName: id.name,
          deviceId: id.deviceId,
        });
        log(mdns);
      } catch (e) {
        log(`mdns: ${String(e)}`);
      }
    })();
  }, [log]);

  useEffect(() => {
    if (!identity || !lan) return;
    const payload = buildPairingPayload(
      {
        deviceId: identity.deviceId,
        ed25519: identity.ed25519,
        x25519: identity.x25519,
      },
      identity.name,
      "windows",
      lan.ip ?? undefined,
      lan.port || DEFAULT_PORT,
    );
    void QRCode.toDataURL(pairingQrText(payload), {
      width: 280,
      margin: 1,
    }).then(setQrDataUrl);
  }, [identity, lan]);

  useEffect(() => {
    if (!session) return;
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(
        await listen<string>("ws-message", (event) => {
          void session.handleIncomingRaw(event.payload);
        }),
      );
      unsubs.push(
        await listen<{ connected: boolean; addr?: string }>("ws-peer", (e) => {
          log(
            e.payload.connected
              ? `peer connected ${e.payload.addr ?? ""}`
              : "peer disconnected",
          );
          void invoke<LanInfo>("get_lan_info").then(setLan);
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, [session, log]);

  async function onPairPaste(): Promise<void> {
    const parsed = parsePairingQr(pairPaste.trim());
    if (!parsed) {
      log("invalid pairing payload");
      return;
    }
    const next: StoredPeer = {
      deviceId: parsed.device.deviceId,
      name: parsed.device.name,
      deviceType: parsed.device.type,
      ed25519PublicKey: parsed.device.ed25519PublicKey,
      x25519PublicKey: parsed.device.x25519PublicKey,
    };
    await savePeer(next);
    setPeer(next);
    log(`paired with ${next.name} (${deviceFingerprint(parsed.device)})`);
  }

  async function onSendClipboard(): Promise<void> {
    if (!session) return;
    const text = await readText();
    if (!text) {
      log("clipboard empty");
      return;
    }
    const url = parseAllowedUrl(text);
    if (url) {
      await session.sendShareUrl(url);
      log(`sent clipboard url ${url}`);
      return;
    }
    await session.sendClipboard(text);
    log("sent clipboard text");
  }

  async function onUnpair(): Promise<void> {
    await clearPeer();
    session?.clearPeer();
    setPeer(null);
    log("peer cleared");
  }

  async function onFirewall(): Promise<void> {
    try {
      const msg = await invoke<string>("ensure_firewall_rule");
      setFirewallMsg(msg);
      log(msg);
    } catch (e) {
      const msg = String(e);
      setFirewallMsg(msg);
      log(msg);
    }
  }

  function onRelayToggle(): void {
    if (relay) {
      relay.disconnect();
      setRelay(null);
      setRelayStatus("off");
      log("relay stopped");
      return;
    }
    if (!identity || !session) {
      log("identity not ready");
      return;
    }
    const client = new RelayClient(toDeviceKeys(identity), peer?.deviceId, {
      onMessage: (raw) => {
        void session.handleIncomingRaw(raw);
      },
      onStatus: (s) => {
        setRelayStatus(s);
        log(s);
      },
    });
    client.connect();
    setRelay(client);
  }

  async function onSendLinkRelayAware(): Promise<void> {
    if (!session || !identity) return;
    const url = parseAllowedUrl(sendUrl);
    if (!url) {
      log("url not allowed");
      return;
    }
    try {
      await session.sendShareUrl(url);
      log(`sent link via LAN ${url}`);
      return;
    } catch {
      /* fall through to relay */
    }
    if (!relay || !peer) {
      log("LAN send failed and relay not connected");
      return;
    }
    const body = shareUrlBody(identity.deviceId, url, peer.deviceId);
    if (!body) return;
    const frame = encryptFrame(body, toDeviceKeys(identity), {
      deviceId: peer.deviceId,
      ed25519PublicKey: peer.ed25519PublicKey,
      x25519PublicKey: peer.x25519PublicKey,
    });
    relay.send(serializeFrame(frame));
    log(`sent link via relay ${url}`);
  }

  return (
    <main className="app">
      <header>
        <h1>involvex Sync</h1>
        <p className="muted">
          LAN listener {lan?.status.listening ? "up" : "starting…"} on port{" "}
          {lan?.port ?? DEFAULT_PORT}
          {lan?.ip ? ` · ${lan.ip}` : ""}
          {lan?.status.peerConnected
            ? ` · peer ${lan.status.peerAddr}`
            : " · waiting for phone"}
        </p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>This PC</h2>
          {identity ? (
            <>
              <p>
                <strong>{identity.name}</strong>
              </p>
              <p className="mono small">{identity.deviceId}</p>
              <p className="mono small">
                fp{" "}
                {deviceFingerprint({
                  deviceId: identity.deviceId,
                  name: identity.name,
                  type: "windows",
                  ed25519PublicKey: identity.ed25519.publicKey,
                  x25519PublicKey: identity.x25519.publicKey,
                })}
              </p>
              {qrDataUrl ? (
                <img className="qr" src={qrDataUrl} alt="Pairing QR code" />
              ) : null}
              <p className="muted small">
                Scan with the Android app, or paste the phone QR JSON below.
              </p>
            </>
          ) : (
            <p>Loading identity…</p>
          )}
        </article>

        <article className="card">
          <h2>Paired phone</h2>
          {peer ? (
            <>
              <p>
                <strong>{peer.name}</strong> ({peer.deviceType})
              </p>
              <p className="mono small">{peer.deviceId}</p>
              <button type="button" onClick={() => void onUnpair()}>
                Unpair
              </button>
            </>
          ) : (
            <p className="muted">No peer yet.</p>
          )}
          <label className="stack">
            Paste phone pairing JSON
            <textarea
              value={pairPaste}
              onChange={(e) => setPairPaste(e.target.value)}
              rows={5}
              placeholder='{"kind":"involvex-sync-pair",...}'
            />
          </label>
          <button type="button" onClick={() => void onPairPaste()}>
            Pair
          </button>
        </article>

        <article className="card">
          <h2>Send to phone</h2>
          <label className="stack">
            URL
            <input
              value={sendUrl}
              onChange={(e) => setSendUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <div className="row">
            <button type="button" onClick={() => void onSendLinkRelayAware()}>
              Send link
            </button>
            <button type="button" onClick={() => void onSendClipboard()}>
              Send clipboard
            </button>
          </div>
          <p className="muted small">
            Phone shows a notification; tap opens the browser (Android 10+).
          </p>
        </article>

        <article className="card">
          <h2>LAN comfort + away</h2>
          <div className="row">
            <button type="button" onClick={() => void onFirewall()}>
              Allow port on private firewall
            </button>
            <button
              type="button"
              onClick={() => {
                void enableAutostart()
                  .then(() => log("autostart enabled"))
                  .catch((e) => log(`autostart: ${String(e)}`));
              }}
            >
              Enable autostart
            </button>
            <button type="button" onClick={onRelayToggle}>
              {relay ? "Stop relay" : "Connect Cloudflare relay"}
            </button>
          </div>
          {firewallMsg ? <p className="small">{firewallMsg}</p> : null}
          <p className="muted small">Relay: {relayStatus}</p>
          <p className="muted small">
            mDNS advertises <code>_invxconnect._tcp.local</code>. Prefer LAN at
            home; use the relay (or MyFritz host on the phone) when away.
          </p>
        </article>
      </section>

      <section className="card log">
        <h2>Activity</h2>
        <ul>
          {logs.map((line) => (
            <li key={line} className="mono small">
              {line}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
