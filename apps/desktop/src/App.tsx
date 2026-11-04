import {
  DEFAULT_PORT,
  MAX_CHUNKED_FILE_BYTES,
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
import {
  readText,
  writeImage,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import QRCode from "qrcode";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
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

type NavTab =
  | "connection"
  | "send"
  | "files"
  | "commands"
  | "keyboard"
  | "history"
  | "settings";

type Toast = {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
};

type ShellResult = {
  ok: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
};

const NAV_LABELS: Record<NavTab, string> = {
  connection: "Connection",
  send: "Send",
  files: "Files",
  commands: "Commands",
  keyboard: "Keyboard",
  history: "History",
  settings: "Settings",
};

let toastSeq = 0;

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
  const [phoneKeyboardActive, setPhoneKeyboardActive] = useState(false);
  const [phoneKeyboardMode, setPhoneKeyboardMode] = useState<
    "ime" | "a11y" | "none"
  >("none");
  const [tab, setTab] = useState<NavTab>("connection");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [defaultIncomingDir, setDefaultIncomingDir] = useState("");
  const [termuxCmd, setTermuxCmd] = useState("");
  const [adbCmd, setAdbCmd] = useState("");
  const [cmdOutput, setCmdOutput] = useState("");
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sessionRef = useRef<SyncSession | null>(null);
  const messageQueueRef = useRef<string[]>([]);

  const log = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${stamp}] ${line}`, ...prev].slice(0, 80));
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, kind, text }].slice(-5));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const pushHistory = useCallback(
    (text: string, direction: ClipboardHistoryEntry["direction"]) => {
      setHistory(appendClipboardHistory(text, direction));
    },
    [],
  );

  const notifyPairRequest = useCallback(async (request: PairRequestPayload) => {
    try {
      await invoke("show_main_window_cmd");
    } catch {
      /* ignore if already visible */
    }
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const perm = await requestPermission();
        granted = perm === "granted";
      }
      if (granted) {
        sendNotification({
          title: "Pair request",
          body: `${request.device.name} wants to pair with this PC`,
        });
      }
    } catch {
      /* notification optional */
    }
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
        pushHistory(text, "in");
        log("clipboard updated from peer");
      },
      onFileTransfer: async (file) => {
        try {
          const dir = settingsRef.current.incomingFilesDir.trim() || null;
          const path = await invoke<string>("save_incoming_file", {
            name: file.name,
            dataBase64: file.dataBase64,
            directory: dir,
          });
          log(`saved file → ${path}`);
          toast(`Saved ${file.name}`, "ok");
        } catch (e) {
          log(`file save failed: ${String(e)}`);
          toast("File save failed", "err");
        }
      },
      onRemoteCommand: async (request) => {
        if (request.shell !== "pwsh") {
          log(`remote cmd ignored (shell=${request.shell})`);
          await sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: false,
            stderr: `desktop only runs pwsh (got ${request.shell})`,
            stdout: "",
          });
          return;
        }
        if (!settingsRef.current.allowRemotePwsh) {
          log("remote pwsh denied (enable in Settings)");
          toast("Remote PowerShell blocked — enable in Settings", "err");
          await sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: false,
            stderr: "remote PowerShell disabled on PC",
            stdout: "",
          });
          return;
        }
        try {
          const result = await invoke<ShellResult>("run_pwsh", {
            command: request.command,
            timeoutMs: request.timeoutMs ?? 30_000,
          });
          log(
            `pwsh ${result.ok ? "ok" : "fail"} exit=${result.exitCode ?? "?"}`,
          );
          setCmdOutput(
            [result.stdout, result.stderr].filter(Boolean).join("\n") ||
              `(exit ${result.exitCode ?? "?"})`,
          );
          await sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: result.ok,
            exitCode: result.exitCode ?? undefined,
            stdout: result.stdout,
            stderr: result.stderr,
          });
          toast(
            result.ok ? "Remote pwsh done" : "Remote pwsh failed",
            result.ok ? "ok" : "err",
          );
        } catch (e) {
          const msg = String(e);
          log(`pwsh error: ${msg}`);
          await sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: false,
            stdout: "",
            stderr: msg,
          });
        }
      },
      onRemoteCommandResult: (result) => {
        const text = [
          result.ok ? "ok" : "fail",
          result.exitCode != null ? `exit ${result.exitCode}` : "",
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n");
        setCmdOutput(text);
        log(`remote result ${result.requestId}: ${result.ok ? "ok" : "fail"}`);
        toast(
          result.ok ? "Phone command ok" : "Phone command failed",
          result.ok ? "ok" : "err",
        );
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
      onKeyboardStatus: (active, mode) => {
        const resolved =
          mode ?? (active ? ("ime" as const) : ("none" as const));
        setPhoneKeyboardActive(active);
        setPhoneKeyboardMode(resolved);
        log(
          active
            ? `phone keyboard ready (${resolved})`
            : "phone keyboard inactive",
        );
      },
      onPairRequest: (request) => {
        setPendingPair(request);
        setTab("connection");
        void notifyPairRequest(request);
        toast(`${request.device.name} wants to pair`, "info");
        log(
          `pair request from ${request.device.name} (${deviceFingerprint(request.device)})`,
        );
      },
      onLog: log,
    });
  }, [identity, log, notifyPairRequest, pushHistory, toast]);

  useEffect(() => {
    sessionRef.current = session;
    if (!session) return;
    const queued = messageQueueRef.current.splice(0);
    for (const raw of queued) {
      void session.handleIncomingRaw(raw);
    }
  }, [session]);

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
        const dir = await invoke<string>("default_incoming_dir");
        setDefaultIncomingDir(dir);
      } catch {
        /* ignore */
      }
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

  // Early ws-message queue so cold-start pair requests are not dropped.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(
        await listen<string>("ws-message", (event) => {
          const current = sessionRef.current;
          if (current) {
            void current.handleIncomingRaw(event.payload);
          } else {
            messageQueueRef.current.push(event.payload);
            if (messageQueueRef.current.length > 40) {
              messageQueueRef.current.shift();
            }
          }
        }),
      );
      unsubs.push(
        await listen<{ connected: boolean; addr?: string }>("ws-peer", (e) => {
          log(
            e.payload.connected
              ? `peer connected ${e.payload.addr ?? ""}`
              : "peer disconnected",
          );
          if (e.payload.connected) {
            toast("Phone connected", "ok");
          } else {
            toast("Phone disconnected", "info");
          }
          void invoke<LanInfo>("get_lan_info").then(setLan);
        }),
      );
      unsubs.push(
        await listen<string>("isync-share", (e) => {
          void (async () => {
            const s = sessionRef.current;
            if (!s) return;
            try {
              const url = parseAllowedUrl(e.payload) ?? e.payload.trim();
              if (!parseAllowedUrl(url)) {
                log(`isync share rejected: ${e.payload}`);
                return;
              }
              await s.sendShareUrl(url);
              pushHistory(url, "out");
              log(`isync share → ${url}`);
            } catch (err) {
              log(`isync share failed: ${String(err)}`);
            }
          })();
        }),
      );
      unsubs.push(
        await listen<string>("isync-clipboard", (e) => {
          void (async () => {
            const s = sessionRef.current;
            if (!s) return;
            try {
              const text = e.payload;
              await writeText(text);
              const url = parseAllowedUrl(text);
              if (url) {
                await s.sendShareUrl(url);
              } else {
                await s.sendClipboard(text);
              }
              pushHistory(text, "out");
              log("isync clipboard → phone");
            } catch (err) {
              log(`isync clipboard failed: ${String(err)}`);
            }
          })();
        }),
      );
      unsubs.push(
        await listen("isync-find", () => {
          void sessionRef.current
            ?.sendFindPhone()
            .then(() => log("isync find phone"))
            .catch((err) => log(`isync find failed: ${String(err)}`));
        }),
      );
      unsubs.push(
        await listen<string>("isync-keyboard", (e) => {
          void (async () => {
            const s = sessionRef.current;
            if (!s) return;
            try {
              const raw = JSON.parse(e.payload) as {
                type?: string;
                text?: string;
                key?: string;
              };
              if (raw.type === "text" && raw.text) {
                await s.sendKeyboardText(raw.text);
                log(`isync keyboard text (${raw.text.length} chars)`);
                return;
              }
              if (raw.type === "key" && raw.key) {
                await s.sendKeyboardKey(
                  raw.key as
                    | "enter"
                    | "backspace"
                    | "tab"
                    | "escape"
                    | "arrow_left"
                    | "arrow_right"
                    | "arrow_up"
                    | "arrow_down"
                    | "delete",
                );
                log(`isync keyboard key ${raw.key}`);
                return;
              }
              log(`isync keyboard ignored: ${e.payload}`);
            } catch (err) {
              log(`isync keyboard failed: ${String(err)}`);
            }
          })();
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, [log, pushHistory, toast]);

  const live = Boolean(peer && lan?.status.peerConnected);
  const keyboardReady = settings.sendKeysToPhone && live && phoneKeyboardActive;

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
    toast(`Paired with ${next.name}`, "ok");
  }

  async function onRejectPair(): Promise<void> {
    if (!session) return;
    await session.rejectPair("user rejected");
    setPendingPair(null);
    log("pair rejected");
    toast("Pair rejected", "info");
  }

  async function onPairPaste(): Promise<void> {
    const parsed = parsePairingQr(pairPaste.trim());
    if (!parsed) {
      log("invalid pairing payload");
      toast("Invalid pairing JSON", "err");
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
    toast(`Paired with ${next.name} — wait for Connect on phone`, "ok");
  }

  async function onSendClipboard(): Promise<void> {
    if (!session || !live) {
      toast("Phone not connected", "err");
      return;
    }
    try {
      const text = await readText();
      if (!text) {
        log("clipboard empty");
        toast("Clipboard empty", "err");
        return;
      }
      const url = parseAllowedUrl(text);
      if (url) {
        await session.sendShareUrl(url);
        pushHistory(url, "out");
        log(`sent clipboard url ${url}`);
        toast("Link sent", "ok");
        return;
      }
      await session.sendClipboard(text);
      pushHistory(text, "out");
      log("sent clipboard text");
      toast("Clipboard sent", "ok");
    } catch (e) {
      log(`send clipboard: ${String(e)}`);
      toast("Send failed", "err");
    }
  }

  async function onUnpair(): Promise<void> {
    await clearPeer();
    session?.clearPeer();
    setPeer(null);
    log("peer cleared");
    toast("Unpaired", "info");
  }

  async function onFirewall(): Promise<void> {
    try {
      const msg = await invoke<string>("ensure_firewall_rule");
      setFirewallMsg(msg);
      log(msg);
      toast(msg, "ok");
    } catch (e) {
      const msg = String(e);
      setFirewallMsg(msg);
      log(msg);
      toast(msg, "err");
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
      toast("URL not allowed", "err");
      return;
    }
    if (live) {
      try {
        await session.sendShareUrl(url);
        pushHistory(url, "out");
        log(`sent link via LAN ${url}`);
        toast("Link sent", "ok");
        return;
      } catch (e) {
        log(`LAN send failed: ${String(e)}`);
      }
    }
    if (!relay || !peer) {
      log("LAN send failed and relay not connected");
      toast("Phone not connected — open Sync and tap Connect", "err");
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
    toast("Link sent via relay", "ok");
  }

  async function onFindPhone(): Promise<void> {
    if (!session || !live) {
      toast("Phone not connected", "err");
      return;
    }
    try {
      await session.sendFindPhone();
      log("find phone sent");
      toast("Find phone sent", "ok");
    } catch (e) {
      log(`find phone: ${String(e)}`);
      toast("Find phone failed", "err");
    }
  }

  async function sendKeyboardText(): Promise<void> {
    if (!session || !keyboardReady || !keyboardText) return;
    const text = keyboardText;
    try {
      await session.sendKeyboardText(text);
      setKeyboardText("");
      log(`keys → phone (${text.length} chars)`);
      toast("Typed on phone", "ok");
    } catch (e) {
      log(`keyboard: ${String(e)}`);
      toast("Keyboard send failed", "err");
    }
  }

  async function resendHistory(entry: ClipboardHistoryEntry): Promise<void> {
    if (!session || !live) {
      toast("Phone not connected", "err");
      return;
    }
    try {
      const url = parseAllowedUrl(entry.text);
      if (url) await session.sendShareUrl(url);
      else await session.sendClipboard(entry.text);
      pushHistory(entry.text, "out");
      log("resent from history");
      toast("Resent", "ok");
    } catch (e) {
      log(`resend failed: ${String(e)}`);
      toast("Resend failed", "err");
    }
  }

  async function copyPairingJson(): Promise<void> {
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
    await writeText(pairingQrText(payload));
    toast("Pairing JSON copied", "ok");
    log("pairing JSON copied");
  }

  async function onPickAndSendFile(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !session || !live) {
      if (!live) toast("Phone not connected", "err");
      return;
    }
    if (file.size > MAX_CHUNKED_FILE_BYTES) {
      toast(
        `File too large (max ${Math.floor(MAX_CHUNKED_FILE_BYTES / (1024 * 1024))} MiB)`,
        "err",
      );
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast("Large file — sending in chunks…", "info");
    }
    try {
      // Keep raw bytes only; session streams base64 per chunk (no giant string).
      const data = new Uint8Array(await file.arrayBuffer());
      await session.sendFile({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data,
      });
      log(`sent file ${file.name} (${file.size} B)`);
      toast(`Sent ${file.name}`, "ok");
    } catch (e) {
      log(`send file: ${String(e)}`);
      toast("Send file failed", "err");
    }
  }

  async function onRunTermux(): Promise<void> {
    if (!session || !live || !termuxCmd.trim()) {
      toast("Phone not connected or empty command", "err");
      return;
    }
    const requestId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    try {
      await session.sendRemoteCommand({
        requestId,
        shell: "termux",
        command: termuxCmd.trim(),
        timeoutMs: 30_000,
      });
      log(`termux → phone: ${termuxCmd.trim()}`);
      toast("Termux command sent", "ok");
    } catch (e) {
      log(`termux send: ${String(e)}`);
      toast("Termux send failed", "err");
    }
  }

  async function onRunAdb(): Promise<void> {
    if (!adbCmd.trim()) {
      toast("Empty adb command", "err");
      return;
    }
    try {
      const result = await invoke<ShellResult>("run_adb_shell", {
        command: adbCmd.trim(),
        timeoutMs: 30_000,
      });
      setCmdOutput(
        [result.stdout, result.stderr].filter(Boolean).join("\n") ||
          `(exit ${result.exitCode ?? "?"})`,
      );
      log(`adb ${result.ok ? "ok" : "fail"}`);
      toast(result.ok ? "ADB ok" : "ADB failed", result.ok ? "ok" : "err");
    } catch (e) {
      const msg = String(e);
      setCmdOutput(msg);
      log(`adb: ${msg}`);
      toast("ADB failed (is adb on PATH?)", "err");
    }
  }

  async function onScreenshot(): Promise<void> {
    if (screenshotBusy) return;
    setScreenshotBusy(true);
    try {
      const path = await invoke<string>("adb_screencap", { timeoutMs: 20_000 });
      await writeImage(path);
      log(`screenshot → clipboard (${path})`);
      toast("Screenshot copied to clipboard", "ok");
    } catch (e) {
      const msg = String(e);
      log(`screenshot: ${msg}`);
      toast("Screenshot failed (USB debugging / adb?)", "err");
      setCmdOutput(msg);
    } finally {
      setScreenshotBusy(false);
    }
  }

  const offlineHint =
    "Phone not connected — open Sync on the phone and tap Connect.";
  const incomingDirDisplay =
    settings.incomingFilesDir.trim() ||
    defaultIncomingDir ||
    "Downloads/involvex-Sync";

  return (
    <div className="app-shell">
      <aside className="nav">
        <p className="nav-brand">involvex</p>
        <p className="nav-title">Sync</p>
        {(Object.keys(NAV_LABELS) as NavTab[]).map((id) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "active" : undefined}
            onClick={() => setTab(id)}
          >
            {NAV_LABELS[id]}
          </button>
        ))}
      </aside>

      <div className="main">
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>

        <header className="topbar">
          <h1>{NAV_LABELS[tab]}</h1>
          <div className="status-strip">
            <span className={`pill ${lan?.status.listening ? "live" : "warn"}`}>
              <span className="dot" />
              {lan?.status.listening ? "LAN up" : "LAN…"}
              {lan?.ip ? ` · ${lan.ip}:${lan.port}` : ""}
            </span>
            <span className={`pill ${live ? "live" : ""}`}>
              <span className="dot" />
              {live
                ? `Live · ${lan?.status.peerAddr ?? peer?.name}`
                : peer
                  ? "Paired · offline"
                  : "No peer"}
            </span>
          </div>
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
              <button
                type="button"
                className="ghost"
                onClick={() => void onRejectPair()}
              >
                Reject
              </button>
            </div>
          </section>
        ) : null}

        {tab === "connection" ? (
          <div className="panel-grid">
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
                  <div className="row">
                    <button
                      type="button"
                      onClick={() => void copyPairingJson()}
                    >
                      Copy pairing JSON
                    </button>
                  </div>
                  <p className="muted small">
                    Phone: Nearby Pair, or Scan PC QR.
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
                  <p className={live ? "status-ok" : "muted small"}>
                    {live ? "Connected" : "Offline — Connect on phone"}
                  </p>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void onUnpair()}
                  >
                    Unpair
                  </button>
                </>
              ) : (
                <p className="muted">
                  No peer yet — wait for a LAN pair request or paste JSON.
                </p>
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
          </div>
        ) : null}

        {tab === "send" ? (
          <article className="card">
            <h2>Send to phone</h2>
            {!live ? <p className="hint">{offlineHint}</p> : null}
            <label className="stack">
              URL
              <input
                value={sendUrl}
                onChange={(e) => setSendUrl(e.target.value)}
                placeholder="https://…"
                disabled={!live && !relay}
              />
            </label>
            <div className="row">
              <button
                type="button"
                disabled={!live && !relay}
                onClick={() => void onSendLinkRelayAware()}
              >
                Send link
              </button>
              <button
                type="button"
                disabled={!live}
                onClick={() => void onSendClipboard()}
              >
                Send clipboard
              </button>
              <button
                type="button"
                disabled={!live}
                onClick={() => void onFindPhone()}
              >
                Find phone
              </button>
              <button
                type="button"
                className="ghost"
                disabled={screenshotBusy}
                onClick={() => void onScreenshot()}
                title="adb screencap → PC clipboard (USB debugging)"
              >
                {screenshotBusy ? "Capturing…" : "Screenshot"}
              </button>
            </div>
            <p className="muted small">
              Screenshot uses ADB (like scrcpy) — phone needs USB/Wi‑Fi
              debugging; image goes to the PC clipboard.
            </p>
          </article>
        ) : null}

        {tab === "files" ? (
          <article className="card">
            <h2>Files</h2>
            {!live ? <p className="hint">{offlineHint}</p> : null}
            <p className="muted small">
              Incoming saves to <code>{incomingDirDisplay}</code>
            </p>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => void onPickAndSendFile(e)}
            />
            <div className="row">
              <button
                type="button"
                disabled={!live}
                onClick={() => fileInputRef.current?.click()}
              >
                Send file to phone
              </button>
            </div>
            <p className="muted small">
              Change the save folder under Settings. Phone must allow storage /
              rebuild after cleartext plugins.
            </p>
          </article>
        ) : null}

        {tab === "commands" ? (
          <div className="panel-grid">
            <article className="card">
              <h2>Termux on phone</h2>
              {!live ? <p className="hint">{offlineHint}</p> : null}
              <p className="muted small">
                Runs via InVx Termux when the phone allows remote Termux.
              </p>
              <label className="stack">
                Command
                <textarea
                  value={termuxCmd}
                  onChange={(e) => setTermuxCmd(e.target.value)}
                  rows={3}
                  placeholder="echo hello"
                  disabled={!live}
                />
              </label>
              <button
                type="button"
                disabled={!live || !termuxCmd.trim()}
                onClick={() => void onRunTermux()}
              >
                Run on phone
              </button>
            </article>
            <article className="card">
              <h2>ADB (local)</h2>
              <p className="muted small">
                Runs <code>adb shell …</code> on this PC (USB/Wi‑Fi debugging).
              </p>
              <div className="row">
                <button
                  type="button"
                  disabled={screenshotBusy}
                  onClick={() => void onScreenshot()}
                >
                  {screenshotBusy ? "Capturing…" : "Screenshot → clipboard"}
                </button>
              </div>
              <label className="stack">
                Shell command
                <textarea
                  value={adbCmd}
                  onChange={(e) => setAdbCmd(e.target.value)}
                  rows={3}
                  placeholder="pm list packages -3"
                />
              </label>
              <button
                type="button"
                disabled={!adbCmd.trim()}
                onClick={() => void onRunAdb()}
              >
                Run adb shell
              </button>
            </article>
            <article className="card">
              <h2>Output</h2>
              <pre className="mono small cmd-out">
                {cmdOutput || "No output yet."}
              </pre>
            </article>
          </div>
        ) : null}

        {tab === "keyboard" ? (
          <article className="card">
            <h2>Sync Keyboard</h2>
            <div className="lights">
              <span className={`light ${settings.sendKeysToPhone ? "on" : ""}`}>
                <span className="dot" /> Setting
              </span>
              <span className={`light ${live ? "on" : ""}`}>
                <span className="dot" /> WS live
              </span>
              <span className={`light ${phoneKeyboardActive ? "on" : ""}`}>
                <span className="dot" />{" "}
                {phoneKeyboardMode === "a11y"
                  ? "Phone a11y"
                  : phoneKeyboardMode === "ime"
                    ? "Phone IME"
                    : "Phone recv"}
              </span>
            </div>
            {keyboardReady ? (
              <p className="status-ok">
                Typing to phone via{" "}
                {phoneKeyboardMode === "a11y" ? "accessibility" : "IME"}
              </p>
            ) : (
              <p className="muted small">
                {!settings.sendKeysToPhone
                  ? "Enable “Send keys to phone” in Settings."
                  : !live
                    ? offlineHint
                    : "On the phone: select Sync Keyboard IME, or enable accessibility receive."}
              </p>
            )}
            <label className="stack">
              Text
              <textarea
                value={keyboardText}
                onChange={(e) => setKeyboardText(e.target.value)}
                rows={3}
                placeholder="Type here, then Send…"
                disabled={!keyboardReady}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  void sendKeyboardText();
                }}
              />
            </label>
            <div className="row">
              <button
                type="button"
                disabled={!keyboardReady || !keyboardText}
                onClick={() => void sendKeyboardText()}
              >
                Send
              </button>
              <button
                type="button"
                disabled={!keyboardReady}
                onClick={() => {
                  void session
                    ?.sendKeyboardKey("backspace")
                    .then(() => {
                      log("backspace → phone");
                      toast("Backspace", "ok");
                    })
                    .catch((e) => {
                      log(`keyboard: ${String(e)}`);
                      toast("Keyboard failed", "err");
                    });
                }}
              >
                Backspace
              </button>
              <button
                type="button"
                disabled={!keyboardReady}
                onClick={() => {
                  void session
                    ?.sendKeyboardKey("enter")
                    .then(() => {
                      log("enter → phone");
                      toast("Enter", "ok");
                    })
                    .catch((e) => {
                      log(`keyboard: ${String(e)}`);
                      toast("Keyboard failed", "err");
                    });
                }}
              >
                Enter
              </button>
            </div>
          </article>
        ) : null}

        {tab === "history" ? (
          <article className="card">
            <h2>Clipboard history</h2>
            {!live ? <p className="hint">{offlineHint}</p> : null}
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
                      disabled={!live}
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
              className="ghost"
              onClick={() => {
                clearClipboardHistory();
                setHistory([]);
              }}
            >
              Clear history
            </button>
          </article>
        ) : null}

        {tab === "settings" ? (
          <div className="panel-grid">
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
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.allowRemotePwsh}
                  onChange={(e) => {
                    const next = saveSettings({
                      allowRemotePwsh: e.target.checked,
                    });
                    setSettings(next);
                    log(
                      next.allowRemotePwsh
                        ? "remote PowerShell on"
                        : "remote PowerShell off",
                    );
                    toast(
                      next.allowRemotePwsh
                        ? "Phone can run PowerShell here"
                        : "Remote PowerShell disabled",
                      "info",
                    );
                  }}
                />
                Allow remote PowerShell from phone
              </label>
              <label className="stack">
                Incoming files folder
                <input
                  value={settings.incomingFilesDir}
                  onChange={(e) => {
                    const next = saveSettings({
                      incomingFilesDir: e.target.value,
                    });
                    setSettings(next);
                  }}
                  placeholder={defaultIncomingDir || "Downloads/involvex-Sync"}
                />
              </label>
              <p className="muted small">
                Leave blank for default:{" "}
                {defaultIncomingDir || "Downloads/involvex-Sync"}. Close /
                minimize hides to the tray. Pair requests always notify.
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
                      .then(() => {
                        log("autostart enabled");
                        toast("Autostart enabled", "ok");
                      })
                      .catch((e) => {
                        log(`autostart: ${String(e)}`);
                        toast(`Autostart: ${String(e)}`, "err");
                      });
                  }}
                >
                  Enable autostart
                </button>
                <button type="button" className="ghost" onClick={onRelayToggle}>
                  {relay ? "Stop relay" : "Connect Cloudflare relay"}
                </button>
              </div>
              {firewallMsg ? <p className="small">{firewallMsg}</p> : null}
              <p className="muted small">Relay: {relayStatus}</p>
              <p className="muted small">
                mDNS advertises <code>_invxconnect._tcp.local</code>. Relay is
                for away-from-home — not for LAN pair.
              </p>
            </article>
          </div>
        ) : null}

        <details className="card log" open={logs.length > 0}>
          <summary>Activity ({logs.length})</summary>
          <ul>
            {logs.map((line) => (
              <li key={line} className="mono small">
                {line}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
