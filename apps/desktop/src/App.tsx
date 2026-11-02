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
  type PairRequestPayload,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable as enableAutostart } from "@tauri-apps/plugin-autostart";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendClipboardHistory,
  clearClipboardHistory,
  loadClipboardHistory,
  type ClipboardHistoryEntry,
} from "./services/clipboardHistory";
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
import {
  loadSettings,
  saveSettings,
  type DesktopSettings,
} from "./services/settings";
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
  const [pendingPair, setPendingPair] = useState<PairRequestPayload | null>(
    null,
  );
  const [history, setHistory] = useState<ClipboardHistoryEntry[]>(() =>
    loadClipboardHistory(),
  );
  const [settings, setSettings] = useState<DesktopSettings>(() =>
    loadSettings(),
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [keyboardText, setKeyboardText] = useState("");
  const [phoneImeActive, setPhoneImeActive] = useState(false);

  const log = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${stamp}] ${line}`, ...prev].slice(0, 80));
  }, []);

  const pushHistory = useCallback(
    (text: string, direction: ClipboardHistoryEntry["direction"]) => {
      setHistory(appendClipboardHistory(text, direction));
    },
    [],
  );

  const session = useMemo(() => {
    if (!identity) return null;
    return new SyncSession(identity, {
      onShareUrl: async (url) => {
        await invoke("open_allowed_url", { url });
        log(`opened ${url}`);
      },
      onClipboard: async (text) => {
        await writeText(text);
        pushHistory(text, "in");
        log("clipboard updated from peer");
      },
      onFileTransfer: async (file) => {
        try {
          const path = await invoke<string>("save_incoming_file", {
            name: file.name,
            dataBase64: file.dataBase64,
          });
          log(`saved file → ${path}`);
        } catch (e) {
          log(`file save failed: ${String(e)}`);
        }
      },
      onNotificationMirror: async (note) => {
        if (!settingsRef.current.showPhoneNotifications) {
          log(`notif (ignored): ${note.title}`);
          return;
        }
        try {
          let granted = await isPermissionGranted();
          if (!granted) {
            const perm = await requestPermission();
            granted = perm === "granted";
          }
          if (granted) {
            sendNotification({
              title: note.title || "Phone",
              body: note.body || note.packageName || "",
            });
          }
          log(`notif: ${note.title}`);
        } catch (e) {
          log(`notif failed: ${String(e)}`);
        }
      },
      onKeyboardStatus: (active) => {
        setPhoneImeActive(active);
        log(active ? "phone IME active" : "phone IME inactive");
      },
      onPairRequest: (request) => {
        setPendingPair(request);
        log(
          `pair request from ${request.device.name} (${deviceFingerprint(request.device)})`,
        );
      },
      onLog: log,
    });
  }, [identity, log, pushHistory]);

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

  async function onAcceptPair(): Promise<void> {
    if (!session || !pendingPair) return;
    const next: StoredPeer = {
      deviceId: pendingPair.device.deviceId,
      name: pendingPair.device.name,
      deviceType: pendingPair.device.type,
      ed25519PublicKey: pendingPair.device.ed25519PublicKey,
      x25519PublicKey: pendingPair.device.x25519PublicKey,
    };
    await session.acceptPair(
      pendingPair,
      lan?.ip ?? undefined,
      lan?.port || DEFAULT_PORT,
    );
    await savePeer(next);
    session.setPeer(next);
    setPeer(next);
    setPendingPair(null);
    log(`accepted ${next.name}`);
  }

  async function onRejectPair(): Promise<void> {
    if (!session) return;
    await session.rejectPair("user rejected");
    setPendingPair(null);
    log("pair rejected");
  }

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
      pushHistory(url, "out");
      log(`sent clipboard url ${url}`);
      return;
    }
    await session.sendClipboard(text);
    pushHistory(text, "out");
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
      pushHistory(url, "out");
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
    pushHistory(url, "out");
    log(`sent link via relay ${url}`);
  }

  async function resendHistory(entry: ClipboardHistoryEntry): Promise<void> {
    if (!session) return;
    try {
      const url = parseAllowedUrl(entry.text);
      if (url) await session.sendShareUrl(url);
      else await session.sendClipboard(entry.text);
      pushHistory(entry.text, "out");
      log("resent from history");
    } catch (e) {
      log(`resend failed: ${String(e)}`);
    }
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

      {pendingPair ? (
        <section className="card pair-banner">
          <h2>Pair request</h2>
          <p>
            <strong>{pendingPair.device.name}</strong> wants to pair
          </p>
          <p className="mono small">
            fp {deviceFingerprint(pendingPair.device)}
          </p>
          <div className="row">
            <button type="button" onClick={() => void onAcceptPair()}>
              Accept
            </button>
            <button type="button" onClick={() => void onRejectPair()}>
              Reject
            </button>
          </div>
        </section>
      ) : null}

      <section className="grid">
        <article className="card">
          <h2>This PC</h2>
          {identity ? (
            <>
              <p>
                <strong>{identity.name}</strong>
              </p>
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
                Phone discovers this PC on LAN, or paste JSON in Advanced.
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
            <p className="muted">No peer yet — wait for a LAN pair request.</p>
          )}
          <details>
            <summary>Manual JSON pair</summary>
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
          </details>
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
            <button
              type="button"
              disabled={!peer}
              onClick={() => {
                void session
                  ?.sendFindPhone()
                  .then(() => log("find phone sent"))
                  .catch((e) => log(`find phone: ${String(e)}`));
              }}
            >
              Find phone
            </button>
          </div>
        </article>

        <article className="card">
          <h2>Sync Keyboard</h2>
          {settings.sendKeysToPhone && phoneImeActive ? (
            <p className="status-ok">Typing to phone</p>
          ) : (
            <p className="muted small">
              {settings.sendKeysToPhone
                ? "Waiting for Sync Keyboard on phone…"
                : "Enable “Send keys to phone” in Settings."}
            </p>
          )}
          <label className="stack">
            Text
            <textarea
              value={keyboardText}
              onChange={(e) => setKeyboardText(e.target.value)}
              rows={3}
              placeholder="Type here, then Send…"
              disabled={!settings.sendKeysToPhone || !peer}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey) return;
                e.preventDefault();
                if (!settings.sendKeysToPhone || !session || !peer) return;
                const text = keyboardText;
                if (!text) return;
                void session
                  .sendKeyboardText(text)
                  .then(() => {
                    setKeyboardText("");
                    log(`keys → phone (${text.length} chars)`);
                  })
                  .catch((err) => log(`keyboard: ${String(err)}`));
              }}
            />
          </label>
          <div className="row">
            <button
              type="button"
              disabled={!settings.sendKeysToPhone || !peer || !keyboardText}
              onClick={() => {
                if (!session || !keyboardText) return;
                void session
                  .sendKeyboardText(keyboardText)
                  .then(() => {
                    setKeyboardText("");
                    log("keys → phone");
                  })
                  .catch((e) => log(`keyboard: ${String(e)}`));
              }}
            >
              Send
            </button>
            <button
              type="button"
              disabled={!settings.sendKeysToPhone || !peer}
              onClick={() => {
                void session
                  ?.sendKeyboardKey("backspace")
                  .then(() => log("backspace → phone"))
                  .catch((e) => log(`keyboard: ${String(e)}`));
              }}
            >
              Backspace
            </button>
            <button
              type="button"
              disabled={!settings.sendKeysToPhone || !peer}
              onClick={() => {
                void session
                  ?.sendKeyboardKey("enter")
                  .then(() => log("enter → phone"))
                  .catch((e) => log(`keyboard: ${String(e)}`));
              }}
            >
              Enter
            </button>
          </div>
        </article>

        <article className="card">
          <h2>Clipboard history</h2>
          {history.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            <ul className="history">
              {history.slice(0, 12).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => void writeText(entry.text)}
                    title="Copy"
                  >
                    [{entry.direction}] {entry.text.slice(0, 120)}
                    {entry.text.length > 120 ? "…" : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resendHistory(entry)}
                  >
                    Send
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => {
              clearClipboardHistory();
              setHistory([]);
            }}
          >
            Clear history
          </button>
        </article>

        <article className="card">
          <h2>Settings</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.showPhoneNotifications}
              onChange={(e) => {
                const next = saveSettings({
                  showPhoneNotifications: e.target.checked,
                });
                setSettings(next);
                log(
                  next.showPhoneNotifications
                    ? "phone notifications on"
                    : "phone notifications off",
                );
              }}
            />
            Show phone notifications
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.sendKeysToPhone}
              onChange={(e) => {
                const next = saveSettings({
                  sendKeysToPhone: e.target.checked,
                });
                setSettings(next);
                log(
                  next.sendKeysToPhone
                    ? "send keys to phone on"
                    : "send keys to phone off",
                );
              }}
            />
            Send keys to phone
          </label>
          <p className="muted small">
            Close / minimize hides to the tray. Quit only from the tray menu.
            Phone must enable Notification access + “Mirror to PC”, and select
            Sync Keyboard to receive keys.
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
            mDNS advertises <code>_invxconnect._tcp.local</code>.
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
