import {
  DEFAULT_PORT,
  MAX_CHUNKED_FILE_BYTES,
  buildPairingPayload,
  deviceFingerprint,
  looksLikeUrl,
  pairingQrText,
  parseAllowedUrl,
  parsePairingQr,
} from "@involvex/protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  addImeActiveListener,
  imeCommitText,
  imeSendKey,
  isImeActive,
  isImeReceiveEnabled,
  openImeSettings,
  setImeReceiveEnabled,
} from "./modules/invx-ime/src";
import { startKeepalive, stopKeepalive } from "./modules/invx-keepalive/src";
import {
  addMdnsErrorListener,
  addMdnsServiceFoundListener,
  addMdnsServiceLostListener,
  startMdnsBrowse,
  stopMdnsBrowse,
  type DiscoveredService,
} from "./modules/invx-mdns/src";
import {
  addNotificationMirrorListener,
  isNotifyListenerGranted,
  isNotifyMirrorEnabled,
  openNotifyListenerSettings,
  setNotifyMirrorEnabled,
} from "./modules/invx-notify/src";
import {
  addShareFilesListener,
  addShareListener,
  clearSharedFiles,
  clearSharedText,
  getSharedFiles,
  getSharedText,
  readSharedFileBase64,
} from "./modules/invx-share/src";
import { startTermuxRunCommand } from "./modules/invx-termux/src";
import {
  appendClipboardHistory,
  loadClipboardHistory,
  type ClipboardHistoryEntry,
} from "./src/clipboardHistory";
import {
  type StoredDeviceKeys,
  type StoredPeer,
  clearPeer,
  ensureLocalIdentity,
  loadPeer,
  savePeer,
} from "./src/identity";
import {
  loadAppSettings,
  saveAppSettings,
  type MobileAppSettings,
} from "./src/appSettings";
import { loadTransportPrefs, saveTransportPrefs } from "./src/settings";
import { MobileSession } from "./src/session";
import { allowlistedRunSpec } from "./src/termux";
import { type TransportMode, defaultTransport } from "./src/transport";

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

type PendingFile = { uri: string; name: string; mimeType: string };

export default function App() {
  const [identity, setIdentity] = useState<StoredDeviceKeys | null>(null);
  const [peer, setPeer] = useState<StoredPeer | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [mode, setMode] = useState<TransportMode>("lan");
  const [pairPaste, setPairPaste] = useState("");
  const [status, setStatus] = useState("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [pairingJson, setPairingJson] = useState("");
  const [nearby, setNearby] = useState<DiscoveredService[]>([]);
  const [history, setHistory] = useState<ClipboardHistoryEntry[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingPhase, setPairingPhase] = useState<
    "idle" | "connecting" | "waiting"
  >("idle");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mirrorNotifs, setMirrorNotifs] = useState(false);
  const [listenerGranted, setListenerGranted] = useState(false);
  const [imeReceive, setImeReceive] = useState(false);
  const [imeActive, setImeActive] = useState(false);
  const [finding, setFinding] = useState(false);
  const [appSettings, setAppSettings] = useState<MobileAppSettings>({
    incomingFilesDir: "involvex-Sync",
    allowRemoteTermux: false,
  });
  const [pwshCmd, setPwshCmd] = useState("");
  const [cmdOutput, setCmdOutput] = useState("");
  const sessionRef = useRef<MobileSession | null>(null);
  const imeReceiveRef = useRef(false);
  const imeActiveRef = useRef(false);
  const appSettingsRef = useRef(appSettings);
  const findTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairingPhaseRef = useRef<"idle" | "connecting" | "waiting">("idle");

  pairingPhaseRef.current = pairingPhase;
  appSettingsRef.current = appSettings;

  imeReceiveRef.current = imeReceive;
  imeActiveRef.current = imeActive;

  const log = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${stamp}] ${line}`, ...prev].slice(0, 60));
  }, []);

  const pushHistory = useCallback(
    async (text: string, direction: ClipboardHistoryEntry["direction"]) => {
      const next = await appendClipboardHistory(text, direction);
      setHistory(next);
    },
    [],
  );

  const openUrlViaNotification = useCallback(
    async (url: string) => {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Open on phone",
          body: url,
          data: { url },
        },
        trigger: null,
      });
      log(`notification for ${url}`);
    },
    [log],
  );

  const persistTransport = useCallback(
    (patch: { mode?: TransportMode; host?: string; port?: number }) => {
      void saveTransportPrefs({
        mode: patch.mode ?? mode,
        host: patch.host ?? host,
        port: patch.port ?? (Number(port) || DEFAULT_PORT),
      });
    },
    [mode, host, port],
  );

  useEffect(() => {
    void (async () => {
      await Notifications.requestPermissionsAsync();
      const id = await ensureLocalIdentity("Android");
      setIdentity(id);
      const prefs = await loadTransportPrefs();
      const stored = await loadPeer();
      if (stored) setPeer(stored);
      setMode(prefs.mode);
      // Prefer saved transport host/port; fall back to last paired peer.
      if (prefs.host) {
        setHost(prefs.host);
        setPort(String(prefs.port || DEFAULT_PORT));
      } else if (stored?.host) {
        setHost(stored.host);
        setPort(String(stored.port || DEFAULT_PORT));
      } else {
        setHost("");
        setPort(String(prefs.port || DEFAULT_PORT));
      }
      setHistory(await loadClipboardHistory());
      setMirrorNotifs(await isNotifyMirrorEnabled());
      setListenerGranted(await isNotifyListenerGranted());
      setImeReceive(await isImeReceiveEnabled());
      setImeActive(await isImeActive());
      setAppSettings(await loadAppSettings());
    })();
  }, []);

  const stopFindPhone = useCallback(() => {
    if (findTimerRef.current) {
      clearTimeout(findTimerRef.current);
      findTimerRef.current = null;
    }
    Vibration.cancel();
    setFinding(false);
  }, []);

  const startFindPhone = useCallback(
    (durationMs: number) => {
      stopFindPhone();
      setFinding(true);
      Vibration.vibrate([0, 800, 400, 800], true);
      void Notifications.scheduleNotificationAsync({
        content: {
          title: "Find phone",
          body: "Your PC is looking for this phone",
          sound: true,
          priority: Notifications.AndroidNotificationPriority.MAX,
        },
        trigger: null,
      });
      findTimerRef.current = setTimeout(() => {
        stopFindPhone();
        log("find phone timed out");
      }, durationMs);
      log("find phone ringing");
    },
    [log, stopFindPhone],
  );

  useEffect(() => {
    const sub = addNotificationMirrorListener((note) => {
      const s = sessionRef.current;
      if (!s?.isOpen) return;
      try {
        s.sendNotificationMirror(note);
        log(`notif → PC: ${note.title}`);
      } catch (e) {
        log(`notif mirror failed: ${String(e)}`);
      }
    });
    return () => sub.remove();
  }, [log]);

  useEffect(() => {
    const sub = addImeActiveListener((active) => {
      setImeActive(active);
      sessionRef.current?.sendKeyboardStatus(active && imeReceiveRef.current);
      log(active ? "Sync Keyboard active" : "Sync Keyboard inactive");
    });
    return () => sub.remove();
  }, [log]);

  useEffect(() => {
    if (!identity) return;
    const payload = buildPairingPayload(
      {
        deviceId: identity.deviceId,
        ed25519: identity.ed25519,
        x25519: identity.x25519,
      },
      identity.name,
      "android",
    );
    setPairingJson(pairingQrText(payload));
  }, [identity]);

  const session = useMemo(() => {
    if (!identity) return null;
    const s = new MobileSession(identity, {
      onShareUrl: async (url) => {
        await openUrlViaNotification(url);
        try {
          await Linking.openURL(url);
        } catch {
          /* user taps notification */
        }
      },
      onClipboard: async (text) => {
        await Clipboard.setStringAsync(text);
        await pushHistory(text, "in");
        log("clipboard set from desktop");
      },
      onTermuxOpenUrl: async (url) => {
        try {
          const ok = await startTermuxRunCommand(
            allowlistedRunSpec({ command: "open-url", url }),
          );
          log(ok ? `termux open-url ${url}` : "termux open-url denied");
          if (!ok) {
            await openUrlViaNotification(url);
            try {
              await Linking.openURL(url);
            } catch {
              /* notification fallback */
            }
          }
        } catch (e) {
          log(`termux open-url failed: ${String(e)}`);
          await openUrlViaNotification(url);
        }
      },
      onTermuxClipboardSet: async (text) => {
        try {
          const ok = await startTermuxRunCommand(
            allowlistedRunSpec({ command: "clipboard-set", text }),
          );
          if (ok) {
            await pushHistory(text, "in");
            log("termux clipboard-set");
            return;
          }
          log("termux clipboard denied — using Expo clipboard");
        } catch (e) {
          log(`termux clipboard failed: ${String(e)}`);
        }
        await Clipboard.setStringAsync(text);
        await pushHistory(text, "in");
      },
      onFileTransfer: async (file) => {
        try {
          const root = FileSystem.documentDirectory;
          if (!root) {
            log(`recv file ${file.name} (no document dir)`);
            return;
          }
          const folder =
            appSettingsRef.current.incomingFilesDir || "involvex-Sync";
          const dir = `${root}${folder.replace(/^\/+|\/+$/g, "")}/`;
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          const safe = file.name.replace(/[^\w.-]+/g, "_") || "file.bin";
          const path = `${dir}${safe}`;
          await FileSystem.writeAsStringAsync(path, file.dataBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          log(`saved file → ${path} (${file.size} B)`);
        } catch (e) {
          log(`file save failed: ${String(e)}`);
        }
      },
      onRemoteCommand: async (request) => {
        if (request.shell !== "termux") {
          sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: false,
            stdout: "",
            stderr: `phone only runs termux (got ${request.shell})`,
          });
          return;
        }
        if (!appSettingsRef.current.allowRemoteTermux) {
          log("remote termux denied");
          sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: false,
            stdout: "",
            stderr: "remote Termux disabled on phone",
          });
          return;
        }
        try {
          const ok = await startTermuxRunCommand(
            allowlistedRunSpec({
              command: "shell",
              script: request.command,
            }),
          );
          sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok,
            exitCode: ok ? 0 : 1,
            stdout: ok ? "started in Termux" : "",
            stderr: ok ? "" : "Termux RUN_COMMAND denied or failed",
          });
          log(ok ? `termux started: ${request.command}` : "termux denied");
        } catch (e) {
          const msg = String(e);
          sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: false,
            stdout: "",
            stderr: msg,
          });
          log(`termux: ${msg}`);
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
        log(`pc result: ${result.ok ? "ok" : "fail"}`);
      },
      onKeyboardText: async (text) => {
        if (!imeReceiveRef.current || !imeActiveRef.current) {
          log("keyboard ignored (IME off or inactive)");
          return;
        }
        const ok = await imeCommitText(text);
        log(ok ? `typed ${text.length} chars` : "IME commit failed");
      },
      onKeyboardKey: async (key) => {
        if (!imeReceiveRef.current || !imeActiveRef.current) {
          log("keyboard key ignored");
          return;
        }
        const ok = await imeSendKey(key);
        log(ok ? `key ${key}` : `key ${key} failed`);
      },
      onFindPhone: (durationMs) => {
        startFindPhone(durationMs);
      },
      onPairAccept: async (accept) => {
        if (pairTimerRef.current) {
          clearTimeout(pairTimerRef.current);
          pairTimerRef.current = null;
        }
        const next: StoredPeer = {
          deviceId: accept.device.deviceId,
          name: accept.device.name,
          deviceType: accept.device.type,
          ed25519PublicKey: accept.device.ed25519PublicKey,
          x25519PublicKey: accept.device.x25519PublicKey,
          host: accept.host,
          port: accept.port,
        };
        await savePeer(next);
        setPeer(next);
        const nextHost = accept.host ?? host;
        const nextPort = accept.port || DEFAULT_PORT;
        if (accept.host) setHost(accept.host);
        if (accept.port) setPort(String(accept.port));
        void saveTransportPrefs({
          mode: "lan",
          host: nextHost,
          port: nextPort,
        });
        s.setPeer(next);
        setPairingBusy(false);
        setPairingPhase("idle");
        log(`paired ${next.name} (${deviceFingerprint(accept.device)})`);
        const transport = {
          ...defaultTransport(nextHost),
          mode: "lan" as const,
          host: nextHost,
          port: nextPort,
        };
        s.connect(transport);
        void startKeepalive("involvex Sync", `LAN ${transport.host}`);
        setStatus(`Paired and connected · ${next.name}`);
      },
      onPairReject: (reason) => {
        if (pairTimerRef.current) {
          clearTimeout(pairTimerRef.current);
          pairTimerRef.current = null;
        }
        setPairingBusy(false);
        setPairingPhase("idle");
        log(`pair rejected${reason ? `: ${reason}` : ""}`);
        setStatus("pair rejected");
      },
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        if (
          pairingPhaseRef.current === "connecting" &&
          nextStatus.startsWith("connected")
        ) {
          setPairingPhase("waiting");
        }
        if (
          pairingPhaseRef.current !== "idle" &&
          (nextStatus === "socket error" || nextStatus === "disconnected")
        ) {
          /* keep busy until timeout/cancel so UI can distinguish */
        }
      },
      onLog: log,
    });
    sessionRef.current = s;
    return s;
  }, [
    identity,
    log,
    openUrlViaNotification,
    pushHistory,
    host,
    startFindPhone,
  ]);

  useEffect(() => {
    if (session && peer) session.setPeer(peer);
  }, [session, peer]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const url = response.notification.request.content.data?.url;
        if (typeof url === "string") {
          void Linking.openURL(url);
        }
      },
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    void startMdnsBrowse();
    const found = addMdnsServiceFoundListener((svc) => {
      setNearby((prev) => {
        const without = prev.filter(
          (p) => p.deviceId !== svc.deviceId || p.host !== svc.host,
        );
        return [...without, svc].sort((a, b) => a.name.localeCompare(b.name));
      });
    });
    const lost = addMdnsServiceLostListener((svc) => {
      setNearby((prev) =>
        prev.filter(
          (p) =>
            (svc.deviceId ? p.deviceId !== svc.deviceId : true) &&
            p.name !== svc.name,
        ),
      );
    });
    const err = addMdnsErrorListener((e) => log(`mdns: ${e.message}`));
    return () => {
      found.remove();
      lost.remove();
      err.remove();
      void stopMdnsBrowse();
    };
  }, [log]);

  useEffect(() => {
    const sub = addShareListener((text) => {
      void handleSharedText(text);
    });
    const filesSub = addShareFilesListener((files) => {
      setPendingFiles(files);
      log(`share received ${files.length} file(s)`);
    });
    void getSharedText().then((text) => {
      if (text) void handleSharedText(text);
    });
    void getSharedFiles().then((files) => {
      if (files.length) setPendingFiles(files);
    });
    return () => {
      sub.remove();
      filesSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSharedText(text: string): Promise<void> {
    const s = sessionRef.current;
    if (!s) return;
    try {
      if (looksLikeUrl(text)) {
        s.sendShareUrl(text);
        await pushHistory(text, "out");
        log("shared url → desktop");
      } else {
        s.sendClipboard(text);
        await pushHistory(text, "out");
        log("shared text → desktop clipboard");
      }
      await clearSharedText();
    } catch (e) {
      log(`share failed: ${String(e)} — connect first`);
    }
  }

  async function sendPendingFiles(): Promise<void> {
    const s = sessionRef.current;
    if (!s || !s.isOpen) {
      log("connect before sending files");
      return;
    }
    for (const file of pendingFiles) {
      try {
        const bytes = await readSharedFileBase64(
          file.uri,
          MAX_CHUNKED_FILE_BYTES,
        );
        s.sendFile(bytes);
        log(`sent file ${bytes.name} (${bytes.size} B)`);
      } catch (e) {
        log(`file ${file.name}: ${String(e)}`);
      }
    }
    setPendingFiles([]);
    await clearSharedFiles();
  }

  function clearPairTimer(): void {
    if (pairTimerRef.current) {
      clearTimeout(pairTimerRef.current);
      pairTimerRef.current = null;
    }
  }

  function cancelPairing(): void {
    clearPairTimer();
    setPairingBusy(false);
    setPairingPhase("idle");
    session?.disconnect();
    void stopKeepalive();
    setStatus("idle");
    log("pairing cancelled");
  }

  function startPairTimeout(): void {
    clearPairTimer();
    pairTimerRef.current = setTimeout(() => {
      setPairingBusy((busy) => {
        if (!busy) return busy;
        const phase = pairingPhaseRef.current;
        if (phase === "waiting") {
          log("pair timed out — request reached PC; Accept on the desktop?");
          setStatus("waiting for PC accept timed out");
        } else {
          log(
            "pair timed out — could not reach PC (Wi‑Fi / cleartext / firewall?)",
          );
          setStatus("could not reach PC");
        }
        setPairingPhase("idle");
        sessionRef.current?.disconnect();
        return false;
      });
    }, 30_000);
  }

  function connect(): void {
    if (!session) return;
    const nextPort = Number(port) || DEFAULT_PORT;
    persistTransport({ mode, host, port: nextPort });
    const transport = {
      ...defaultTransport(host),
      mode,
      host,
      port: nextPort,
    };
    session.connect(transport);
    void startKeepalive(
      "involvex Sync",
      mode === "lan" ? `LAN ${host}:${port}` : mode,
    );
  }

  function disconnect(): void {
    clearPairTimer();
    setPairingBusy(false);
    setPairingPhase("idle");
    session?.disconnect();
    void stopKeepalive();
    setStatus("idle");
  }

  function pairWithNearby(svc: DiscoveredService): void {
    if (!session) return;
    setHost(svc.host);
    setPort(String(svc.port));
    setMode("lan");
    void saveTransportPrefs({
      mode: "lan",
      host: svc.host,
      port: svc.port,
    });
    if (peer?.deviceId === svc.deviceId) {
      log(`already paired with ${svc.name} — connecting`);
      session.connect({
        mode: "lan",
        host: svc.host,
        port: svc.port,
        relayUrl: defaultTransport("").relayUrl,
      });
      void startKeepalive("involvex Sync", `LAN ${svc.host}`);
      return;
    }
    setPairingBusy(true);
    setPairingPhase("connecting");
    log(`pairing with ${svc.name} @ ${svc.host}:${svc.port}`);
    setStatus("Waiting for PC to accept…");
    session.connect(
      {
        mode: "lan",
        host: svc.host,
        port: svc.port,
        relayUrl: defaultTransport("").relayUrl,
      },
      { pairing: true },
    );
    startPairTimeout();
  }

  async function pickAndSendFile(): Promise<void> {
    const s = sessionRef.current;
    if (!s?.isOpen) {
      log("not connected — cannot send file");
      return;
    }
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];
      const dataBase64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const size = asset.size ?? Math.floor((dataBase64.length * 3) / 4);
      s.sendFile({
        name: asset.name,
        mimeType: asset.mimeType || "application/octet-stream",
        dataBase64,
        size,
      });
      log(`sent file ${asset.name} (${size} B)`);
    } catch (e) {
      log(`send file: ${String(e)}`);
    }
  }

  function runPwshOnPc(): void {
    const s = sessionRef.current;
    if (!s?.isOpen || !pwshCmd.trim()) {
      log("not connected or empty command");
      return;
    }
    const requestId = `${Date.now().toString(16)}`;
    try {
      s.sendRemoteCommand({
        requestId,
        shell: "pwsh",
        command: pwshCmd.trim(),
        timeoutMs: 30_000,
      });
      setCmdOutput("Waiting for PC…");
      log(`pwsh → PC: ${pwshCmd.trim()}`);
    } catch (e) {
      log(`pwsh send: ${String(e)}`);
    }
  }

  async function applyDesktopPairing(raw: string): Promise<boolean> {
    const parsed = parsePairingQr(raw.trim());
    if (!parsed) {
      log("invalid pairing JSON");
      return false;
    }
    const next: StoredPeer = {
      deviceId: parsed.device.deviceId,
      name: parsed.device.name,
      deviceType: parsed.device.type,
      ed25519PublicKey: parsed.device.ed25519PublicKey,
      x25519PublicKey: parsed.device.x25519PublicKey,
      host: parsed.host,
      port: parsed.port,
    };
    await savePeer(next);
    setPeer(next);
    session?.setPeer(next);
    const nextHost = parsed.host ?? host;
    const nextPort = parsed.port || Number(port) || DEFAULT_PORT;
    if (parsed.host) setHost(parsed.host);
    if (parsed.port) setPort(String(parsed.port));
    setMode("lan");
    void saveTransportPrefs({
      mode: "lan",
      host: nextHost,
      port: nextPort,
    });
    log(`paired ${next.name} (${deviceFingerprint(parsed.device)})`);
    if (session && nextHost) {
      session.connect({
        ...defaultTransport(nextHost),
        mode: "lan",
        host: nextHost,
        port: nextPort,
      });
      void startKeepalive("involvex Sync", `LAN ${nextHost}`);
      setStatus(`Paired and connected · ${next.name}`);
    } else {
      setStatus(`Paired with ${next.name} — tap Connect`);
    }
    return true;
  }

  async function onPair(): Promise<void> {
    await applyDesktopPairing(pairPaste);
  }

  async function openScanner(): Promise<void> {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        log("camera permission denied");
        return;
      }
    }
    setScanLocked(false);
    setScanOpen(true);
  }

  async function onScanPayload(data: string): Promise<void> {
    if (scanLocked) return;
    setScanLocked(true);
    const ok = await applyDesktopPairing(data);
    if (ok) {
      setScanOpen(false);
      log("scanned PC QR");
    } else {
      setScanLocked(false);
    }
  }

  async function onUnpair(): Promise<void> {
    await clearPeer();
    session?.clearPeer();
    setPeer(null);
    log("unpaired");
  }

  async function copyPairingJson(): Promise<void> {
    if (!pairingJson) return;
    await Clipboard.setStringAsync(pairingJson);
    log("pairing JSON copied");
  }

  async function sendClipboardLink(): Promise<void> {
    const text = await Clipboard.getStringAsync();
    const url = parseAllowedUrl(text);
    if (!url) {
      if (text) {
        try {
          sessionRef.current?.sendClipboard(text);
          await pushHistory(text, "out");
          log("sent clipboard text");
        } catch (e) {
          log(`send failed: ${String(e)}`);
        }
      } else {
        log("clipboard empty");
      }
      return;
    }
    sessionRef.current?.sendShareUrl(url);
    await pushHistory(url, "out");
    log(`sent ${url}`);
  }

  async function resendHistory(entry: ClipboardHistoryEntry): Promise<void> {
    try {
      const url = parseAllowedUrl(entry.text);
      if (url) {
        sessionRef.current?.sendShareUrl(url);
      } else {
        sessionRef.current?.sendClipboard(entry.text);
      }
      await pushHistory(entry.text, "out");
      log("resent from history");
    } catch (e) {
      log(`resend failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void getSharedText().then((text) => {
          if (text) void handleSharedText(text);
        });
        void getSharedFiles().then((files) => {
          if (files.length) setPendingFiles(files);
        });
      }
    });
    return () => sub.remove();
  });

  const fp = identity
    ? deviceFingerprint({
        deviceId: identity.deviceId,
        name: identity.name,
        type: "android",
        ed25519PublicKey: identity.ed25519.publicKey,
        x25519PublicKey: identity.x25519.publicKey,
      })
    : "";

  const connected =
    status.startsWith("connected") || status.includes("connected");
  const statusTone = connected
    ? styles.statusLive
    : status === "idle"
      ? styles.statusIdle
      : styles.statusBusy;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />
        <Modal visible={finding} animationType="fade" transparent={false}>
          <View style={styles.findRoot}>
            <Text style={styles.findTitle}>Find phone</Text>
            <Text style={styles.findBody}>
              Your PC is looking for this device.
            </Text>
            <Pressable style={styles.btn} onPress={stopFindPhone}>
              <Text style={styles.btnText}>Dismiss</Text>
            </Pressable>
          </View>
        </Modal>
        <Modal visible={scanOpen} animationType="slide" transparent={false}>
          <SafeAreaView style={styles.scanRoot}>
            <Text style={styles.h2}>Scan PC QR</Text>
            <Text style={styles.muted}>
              Point at the pairing QR on the desktop Connection tab.
            </Text>
            {cameraPermission?.granted ? (
              <CameraView
                style={styles.scanCamera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(result) => {
                  if (result.data) void onScanPayload(result.data);
                }}
              />
            ) : (
              <Text style={styles.muted}>Camera permission required.</Text>
            )}
            <Pressable
              style={styles.btnGhost}
              onPress={() => setScanOpen(false)}
            >
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
          </SafeAreaView>
        </Modal>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <View style={styles.heroGlow} />
            <Text style={styles.brand}>involvex</Text>
            <Text style={styles.title}>Sync</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, statusTone]} />
              <Text style={styles.statusText} numberOfLines={1}>
                {status}
              </Text>
              {peer ? (
                <View style={styles.peerChip}>
                  <Text style={styles.peerChipText} numberOfLines={1}>
                    {peer.name}
                  </Text>
                </View>
              ) : null}
            </View>
            {identity ? (
              <Text style={styles.monoSoft}>fp {fp}</Text>
            ) : (
              <Text style={styles.muted}>Loading identity…</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.h2}>Connection</Text>
            <Text style={styles.muted}>
              Host and mode are saved on this phone.
            </Text>
            <View style={styles.segment}>
              {(["lan", "relay", "myfritz"] as TransportMode[]).map((m) => (
                <Pressable
                  key={m}
                  style={[styles.segmentItem, mode === m && styles.segmentOn]}
                  onPress={() => {
                    setMode(m);
                    persistTransport({ mode: m });
                  }}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      mode === m && styles.segmentTextOn,
                    ]}
                  >
                    {m}
                  </Text>
                </Pressable>
              ))}
            </View>
            {mode !== "relay" ? (
              <View style={styles.fieldGrid}>
                <View style={styles.fieldGrow}>
                  <Text style={styles.label}>Host</Text>
                  <TextInput
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="192.168.1.10"
                    placeholderTextColor="#6b7c99"
                    value={host}
                    onChangeText={(value) => {
                      setHost(value);
                      persistTransport({ host: value });
                    }}
                    onEndEditing={() => persistTransport({ host })}
                  />
                </View>
                <View style={styles.fieldPort}>
                  <Text style={styles.label}>Port</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="number-pad"
                    value={port}
                    onChangeText={(value) => {
                      setPort(value);
                      const n = Number(value);
                      if (n > 0) persistTransport({ port: n });
                    }}
                    onEndEditing={() =>
                      persistTransport({
                        port: Number(port) || DEFAULT_PORT,
                      })
                    }
                  />
                </View>
              </View>
            ) : (
              <Text style={styles.muted}>
                Relay · wss://sync.involvex.workers.dev
              </Text>
            )}
            <View style={styles.row}>
              <Pressable style={[styles.btn, styles.btnFlex]} onPress={connect}>
                <Text style={styles.btnText}>
                  {connected ? "Reconnect" : "Connect"}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.btnGhost, styles.btnFlex]}
                onPress={disconnect}
              >
                <Text style={styles.btnText}>Disconnect</Text>
              </Pressable>
            </View>
            <Pressable
              style={styles.btnGhost}
              onPress={() => void sendClipboardLink()}
            >
              <Text style={styles.btnText}>Send clipboard to PC</Text>
            </Pressable>
          </View>

          {pairingBusy ? (
            <View style={[styles.card, styles.pairWait]}>
              <Text style={styles.h2}>Waiting for PC to accept…</Text>
              <Text style={styles.muted}>
                {pairingPhase === "waiting"
                  ? "Request sent — Accept on the desktop banner."
                  : "Connecting to the PC over LAN…"}
              </Text>
              <Pressable style={styles.btnGhost} onPress={cancelPairing}>
                <Text style={styles.btnText}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Text style={styles.h2}>Nearby</Text>
              <Pressable
                style={styles.btnGhostSm}
                onPress={() => {
                  void stopMdnsBrowse().then(() => startMdnsBrowse());
                  log("rescanning LAN…");
                }}
              >
                <Text style={styles.btnTextSm}>Rescan</Text>
              </Pressable>
            </View>
            <View style={styles.row}>
              <Pressable
                style={[styles.btn, styles.btnFlex]}
                onPress={() => void openScanner()}
              >
                <Text style={styles.btnText}>Scan PC QR</Text>
              </Pressable>
            </View>
            {nearby.length === 0 ? (
              <Text style={styles.muted}>
                Searching for _invxconnect._tcp on your LAN…
              </Text>
            ) : (
              nearby.map((svc) => {
                const isPaired = peer?.deviceId === svc.deviceId;
                return (
                  <View
                    key={`${svc.deviceId}-${svc.host}`}
                    style={styles.nearbyRow}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.body}>
                        {svc.name}
                        {isPaired ? " · paired" : ""}
                      </Text>
                      <Text style={styles.mono}>
                        {svc.host}:{svc.port}
                      </Text>
                    </View>
                    <Pressable
                      style={styles.btn}
                      disabled={pairingBusy}
                      onPress={() => pairWithNearby(svc)}
                    >
                      <Text style={styles.btnText}>
                        {pairingBusy
                          ? "…"
                          : isPaired
                            ? connected
                              ? "Reconnect"
                              : "Connect"
                            : "Pair"}
                      </Text>
                    </Pressable>
                  </View>
                );
              })
            )}
            {peer ? (
              <Pressable style={styles.linkBtn} onPress={() => void onUnpair()}>
                <Text style={styles.linkText}>Unpair {peer.name}</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.h2}>Files</Text>
            <Text style={styles.muted}>
              Saves to Documents/{appSettings.incomingFilesDir}/
            </Text>
            <Pressable
              style={styles.btn}
              onPress={() => void pickAndSendFile()}
            >
              <Text style={styles.btnText}>Send file to PC</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.h2}>Run on PC (PowerShell)</Text>
            <Text style={styles.muted}>
              PC must enable “Allow remote PowerShell”.
            </Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              multiline
              placeholder="Get-Date"
              placeholderTextColor="#6b7c99"
              value={pwshCmd}
              onChangeText={setPwshCmd}
            />
            <Pressable style={styles.btn} onPress={runPwshOnPc}>
              <Text style={styles.btnText}>Run on PC</Text>
            </Pressable>
            {cmdOutput ? (
              <Text style={styles.mono} selectable>
                {cmdOutput}
              </Text>
            ) : null}
          </View>

          {pendingFiles.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.h2}>Pending share</Text>
              {pendingFiles.map((f) => (
                <Text key={f.uri} style={styles.mono}>
                  {f.name} ({f.mimeType})
                </Text>
              ))}
              <Pressable
                style={styles.btn}
                onPress={() => void sendPendingFiles()}
              >
                <Text style={styles.btnText}>Send when connected</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.h2}>Features</Text>
            <Text style={styles.label}>Incoming files folder</Text>
            <TextInput
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              value={appSettings.incomingFilesDir}
              onChangeText={(value) =>
                setAppSettings((prev) => ({
                  ...prev,
                  incomingFilesDir: value,
                }))
              }
              onEndEditing={() => {
                void saveAppSettings({
                  incomingFilesDir: appSettings.incomingFilesDir,
                }).then(setAppSettings);
              }}
              placeholder="involvex-Sync"
              placeholderTextColor="#6b7c99"
            />
            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text style={styles.body}>Allow remote Termux</Text>
                <Text style={styles.muted}>
                  Let the PC run bash via InVx Termux
                </Text>
              </View>
              <Switch
                value={appSettings.allowRemoteTermux}
                onValueChange={(next) => {
                  void saveAppSettings({ allowRemoteTermux: next }).then(
                    setAppSettings,
                  );
                  log(next ? "remote termux on" : "remote termux off");
                }}
                trackColor={{ false: "#243352", true: "#3d7eff" }}
                thumbColor="#e8eef8"
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text style={styles.body}>Sync Keyboard</Text>
                <Text style={styles.muted}>
                  IME {imeActive ? "active" : "inactive"} · enable in Android
                  input settings
                </Text>
              </View>
              <Switch
                value={imeReceive}
                onValueChange={(next) => {
                  void (async () => {
                    await setImeReceiveEnabled(next);
                    setImeReceive(next);
                    sessionRef.current?.sendKeyboardStatus(next && imeActive);
                    log(next ? "receive keyboard on" : "receive keyboard off");
                  })();
                }}
                trackColor={{ false: "#243352", true: "#3d7eff" }}
                thumbColor="#e8eef8"
              />
            </View>
            <Pressable
              style={styles.linkBtn}
              onPress={() => void openImeSettings()}
            >
              <Text style={styles.linkText}>Open IME settings</Text>
            </Pressable>
            <View style={styles.divider} />
            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text style={styles.body}>Notification mirror</Text>
                <Text style={styles.muted}>
                  {listenerGranted
                    ? "Access granted"
                    : "Needs Notification access"}
                </Text>
              </View>
              <Switch
                value={mirrorNotifs}
                onValueChange={(next) => {
                  void (async () => {
                    if (next && !(await isNotifyListenerGranted())) {
                      log("enable Notification access for involvex Sync");
                      await openNotifyListenerSettings();
                      setListenerGranted(await isNotifyListenerGranted());
                      return;
                    }
                    await setNotifyMirrorEnabled(next);
                    setMirrorNotifs(next);
                    setListenerGranted(await isNotifyListenerGranted());
                    log(
                      next
                        ? "notification mirror on"
                        : "notification mirror off",
                    );
                  })();
                }}
                trackColor={{ false: "#243352", true: "#3d7eff" }}
                thumbColor="#e8eef8"
              />
            </View>
            <Pressable
              style={styles.linkBtn}
              onPress={() => {
                void openNotifyListenerSettings().then(async () => {
                  setListenerGranted(await isNotifyListenerGranted());
                });
              }}
            >
              <Text style={styles.linkText}>
                {listenerGranted
                  ? "Manage Notification access"
                  : "Open Notification access"}
              </Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.h2}>Clipboard history</Text>
            {history.length === 0 ? (
              <Text style={styles.muted}>Nothing yet.</Text>
            ) : (
              history.slice(0, 12).map((entry) => (
                <View key={entry.id} style={styles.historyRow}>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() =>
                      void Clipboard.setStringAsync(entry.text).then(() =>
                        log("copied from history"),
                      )
                    }
                  >
                    <Text style={styles.historyText} numberOfLines={2}>
                      [{entry.direction}] {entry.text}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.btnGhostSm}
                    onPress={() => void resendHistory(entry)}
                  >
                    <Text style={styles.btnTextSm}>Send</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>

          <View style={styles.card}>
            <Pressable
              style={styles.headerRow}
              onPress={() => setShowAdvanced((v) => !v)}
            >
              <Text style={styles.h2}>Advanced</Text>
              <Text style={styles.chevron}>{showAdvanced ? "▾" : "▸"}</Text>
            </Pressable>
            {showAdvanced ? (
              <>
                <Text style={styles.label}>Your pairing JSON</Text>
                <TextInput
                  style={[styles.input, styles.multiline]}
                  multiline
                  value={pairingJson}
                  editable={false}
                  selectTextOnFocus
                  showSoftInputOnFocus={false}
                />
                <Pressable
                  style={styles.btnGhost}
                  onPress={() => void copyPairingJson()}
                >
                  <Text style={styles.btnText}>Copy pairing JSON</Text>
                </Pressable>
                <Text style={styles.label}>Paste desktop JSON</Text>
                <Text style={styles.muted}>
                  Prefer Scan PC QR above. Paste only if the camera is
                  unavailable.
                </Text>
                <TextInput
                  style={[styles.input, styles.multiline]}
                  multiline
                  placeholder='{"kind":"involvex-sync-pair",...}'
                  placeholderTextColor="#6b7c99"
                  value={pairPaste}
                  onChangeText={setPairPaste}
                />
                <Pressable style={styles.btn} onPress={() => void onPair()}>
                  <Text style={styles.btnText}>Pair from JSON</Text>
                </Pressable>
              </>
            ) : null}
          </View>

          <View style={styles.card}>
            <Pressable
              style={styles.headerRow}
              onPress={() => setShowActivity((v) => !v)}
            >
              <Text style={styles.h2}>Activity</Text>
              <Text style={styles.chevron}>{showActivity ? "▾" : "▸"}</Text>
            </Pressable>
            {showActivity ? (
              logs.map((line) => (
                <Text key={line} style={styles.mono}>
                  {line}
                </Text>
              ))
            ) : logs[0] ? (
              <Text style={styles.mono} numberOfLines={1}>
                {logs[0]}
              </Text>
            ) : (
              <Text style={styles.muted}>No events yet.</Text>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#070d18" },
  content: { padding: 16, paddingBottom: 32, gap: 14 },
  hero: {
    paddingTop: 8,
    paddingBottom: 4,
    gap: 4,
    overflow: "hidden",
  },
  heroGlow: {
    position: "absolute",
    top: -40,
    right: -20,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(61,126,255,0.18)",
  },
  brand: {
    color: "#7eb0ff",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  title: {
    color: "#e8eef8",
    fontSize: 40,
    fontWeight: "800",
    letterSpacing: -1.2,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLive: { backgroundColor: "#3dcea2" },
  statusIdle: { backgroundColor: "#6b7c99" },
  statusBusy: { backgroundColor: "#f0b35a" },
  statusText: {
    color: "#c8d6ec",
    fontSize: 13,
    flexShrink: 1,
  },
  monoSoft: {
    color: "#6b7c99",
    fontFamily: "monospace",
    fontSize: 11,
    marginTop: 6,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  muted: { color: "#8aa0bf", fontSize: 13, lineHeight: 18 },
  card: {
    backgroundColor: "rgba(14,22,38,0.96)",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(120,150,200,0.14)",
    gap: 10,
  },
  h2: {
    color: "#e8eef8",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  body: { color: "#e8eef8", fontSize: 15, fontWeight: "600" },
  label: { color: "#8aa0bf", fontSize: 12, marginBottom: 4, fontWeight: "600" },
  mono: {
    color: "#9db0cc",
    fontFamily: "monospace",
    fontSize: 12,
  },
  input: {
    backgroundColor: "#0a1424",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(120,150,200,0.22)",
    color: "#e8eef8",
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  fieldGrid: { flexDirection: "row", gap: 10 },
  fieldGrow: { flex: 1 },
  fieldPort: { width: 96 },
  segment: {
    flexDirection: "row",
    backgroundColor: "#0a1424",
    borderRadius: 12,
    padding: 3,
    gap: 2,
  },
  segmentItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 9,
    borderRadius: 10,
  },
  segmentOn: { backgroundColor: "#3d7eff" },
  segmentText: {
    color: "#9db0cc",
    fontWeight: "700",
    fontSize: 12,
    textTransform: "uppercase",
  },
  segmentTextOn: { color: "#fff" },
  nearbyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,150,200,0.16)",
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,150,200,0.16)",
    paddingTop: 10,
  },
  historyText: { color: "#c8d6ec", fontSize: 13 },
  peerChip: {
    backgroundColor: "rgba(61,126,255,0.2)",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: 120,
    marginLeft: "auto",
  },
  peerChipText: { color: "#cfe0ff", fontWeight: "700", fontSize: 11 },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  settingCopy: { flex: 1, gap: 2 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(120,150,200,0.18)",
    marginVertical: 4,
  },
  linkBtn: { paddingVertical: 2 },
  linkText: { color: "#7eb0ff", fontWeight: "600", fontSize: 13 },
  chevron: { color: "#8aa0bf", fontSize: 16 },
  btn: {
    backgroundColor: "#3d7eff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnFlex: { flex: 1 },
  btnGhost: {
    backgroundColor: "#182338",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnGhostSm: {
    backgroundColor: "#182338",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  btnText: { color: "white", fontWeight: "700" },
  btnTextSm: { color: "white", fontWeight: "600", fontSize: 12 },
  findRoot: {
    flex: 1,
    backgroundColor: "#070d18",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  findTitle: {
    color: "#e8eef8",
    fontSize: 32,
    fontWeight: "800",
  },
  findBody: {
    color: "#9db0cc",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 12,
  },
  pairWait: {
    borderColor: "rgba(61,126,255,0.55)",
    backgroundColor: "rgba(61,126,255,0.12)",
  },
  scanRoot: {
    flex: 1,
    backgroundColor: "#070d18",
    padding: 16,
    gap: 12,
  },
  scanCamera: {
    flex: 1,
    borderRadius: 16,
    overflow: "hidden",
    minHeight: 320,
  },
});
