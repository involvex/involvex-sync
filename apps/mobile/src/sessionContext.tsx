import {
  DEFAULT_PORT,
  MAX_CHUNKED_FILE_BYTES,
  buildPairingPayload,
  deviceFingerprint,
  fromBase64,
  looksLikeUrl,
  pairingQrText,
  parseAllowedUrl,
  parsePairingQr,
} from "@involvex/protocol";
import { useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Notifications from "expo-notifications";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { AppState, Linking, Vibration } from "react-native";
import {
  a11yInjectKey,
  a11yInjectText,
  isA11yReceiveEnabled,
  isA11yServiceGranted,
} from "../modules/invx-a11y/src";
import {
  addImeActiveListener,
  imeCommitText,
  imeSendKey,
  isImeActive,
  isImeReceiveEnabled,
} from "../modules/invx-ime/src";
import { startKeepalive, stopKeepalive } from "../modules/invx-keepalive/src";
import {
  addMdnsErrorListener,
  addMdnsServiceFoundListener,
  addMdnsServiceLostListener,
  startMdnsBrowse,
  stopMdnsBrowse,
  type DiscoveredService,
} from "../modules/invx-mdns/src";
import {
  addNotificationMirrorListener,
  isNotifyListenerGranted,
  isNotifyMirrorEnabled,
} from "../modules/invx-notify/src";
import {
  addShareFilesListener,
  addShareListener,
  clearSharedFiles,
  clearSharedText,
  getSharedFiles,
  getSharedText,
  readSharedFileBase64,
} from "../modules/invx-share/src";
import { startTermuxRunCommand } from "../modules/invx-termux/src";
import {
  appendClipboardHistory,
  loadClipboardHistory,
  type ClipboardHistoryEntry,
} from "./clipboardHistory";
import {
  type StoredDeviceKeys,
  type StoredPeer,
  clearPeer,
  ensureLocalIdentity,
  loadPeer,
  savePeer,
} from "./identity";
import {
  loadAppSettings,
  saveAppSettings,
  type MobileAppSettings,
} from "./appSettings";
import { loadTransportPrefs, saveTransportPrefs } from "./settings";
import { MobileSession } from "./session";
import { allowlistedRunSpec } from "./termux";
import { type TransportMode, defaultTransport } from "./transport";

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

export type PendingFile = { uri: string; name: string; mimeType: string };

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

function labelFromSafUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const tree = decoded.split("tree/")[1] ?? decoded;
    const last = tree.split("/").pop() ?? tree;
    return last.replace(/^primary:/, "").replace(/:/g, "/") || "picked folder";
  } catch {
    return "picked folder";
  }
}

export type SessionContextValue = {
  identity: StoredDeviceKeys | null;
  peer: StoredPeer | null;
  host: string;
  setHost: (v: string) => void;
  port: string;
  setPort: (v: string) => void;
  mode: TransportMode;
  setMode: (v: TransportMode) => void;
  pairPaste: string;
  setPairPaste: (v: string) => void;
  status: string;
  logs: string[];
  pairingJson: string;
  nearby: DiscoveredService[];
  history: ClipboardHistoryEntry[];
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean | ((p: boolean) => boolean)) => void;
  showActivity: boolean;
  setShowActivity: (v: boolean | ((p: boolean) => boolean)) => void;
  pendingFiles: PendingFile[];
  pairingBusy: boolean;
  pairingPhase: "idle" | "connecting" | "waiting";
  scanOpen: boolean;
  setScanOpen: (v: boolean) => void;
  cameraPermission: ReturnType<typeof useCameraPermissions>[0];
  mirrorNotifs: boolean;
  listenerGranted: boolean;
  imeReceive: boolean;
  imeActive: boolean;
  a11yReceive: boolean;
  a11yGranted: boolean;
  finding: boolean;
  appSettings: MobileAppSettings;
  setAppSettings: (v: MobileAppSettings) => void;
  pwshCmd: string;
  setPwshCmd: (v: string) => void;
  cmdOutput: string;
  fp: string;
  connected: boolean;
  persistTransport: (patch: {
    mode?: TransportMode;
    host?: string;
    port?: number;
  }) => void;
  log: (line: string) => void;
  stopFindPhone: () => void;
  connect: () => void;
  disconnect: () => void;
  cancelPairing: () => void;
  pairWithNearby: (svc: DiscoveredService) => void;
  pickIncomingFolder: () => Promise<void>;
  clearIncomingFolder: () => Promise<void>;
  pickAndSendFile: () => Promise<void>;
  sendPendingFiles: () => Promise<void>;
  runPwshOnPc: () => void;
  onPair: () => Promise<void>;
  openScanner: () => Promise<void>;
  onScanPayload: (data: string) => Promise<void>;
  onUnpair: () => Promise<void>;
  copyPairingJson: () => Promise<void>;
  sendClipboardLink: () => Promise<void>;
  resendHistory: (entry: ClipboardHistoryEntry) => Promise<void>;
  pushKeyboardStatus: () => void;
  setImeReceive: (v: boolean) => void;
  setA11yReceive: (v: boolean) => void;
  setA11yGranted: (v: boolean) => void;
  setMirrorNotifs: (v: boolean) => void;
  setListenerGranted: (v: boolean) => void;
  imeReceiveRef: MutableRefObject<boolean>;
  a11yReceiveRef: MutableRefObject<boolean>;
  a11yGrantedRef: MutableRefObject<boolean>;
  startMdnsBrowse: typeof startMdnsBrowse;
  stopMdnsBrowse: typeof stopMdnsBrowse;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
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
  const [a11yReceive, setA11yReceive] = useState(false);
  const [a11yGranted, setA11yGranted] = useState(false);
  const [finding, setFinding] = useState(false);
  const [appSettings, setAppSettings] = useState<MobileAppSettings>({
    incomingFilesUri: "",
    incomingFilesLabel: "",
    allowRemoteTermux: false,
    theme: "system",
  });
  const [pwshCmd, setPwshCmd] = useState("");
  const [cmdOutput, setCmdOutput] = useState("");
  const sessionRef = useRef<MobileSession | null>(null);
  const imeReceiveRef = useRef(false);
  const imeActiveRef = useRef(false);
  const a11yReceiveRef = useRef(false);
  const a11yGrantedRef = useRef(false);
  const appSettingsRef = useRef(appSettings);
  const findTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairingPhaseRef = useRef<"idle" | "connecting" | "waiting">("idle");

  pairingPhaseRef.current = pairingPhase;
  appSettingsRef.current = appSettings;

  imeReceiveRef.current = imeReceive;
  imeActiveRef.current = imeActive;
  a11yReceiveRef.current = a11yReceive;
  a11yGrantedRef.current = a11yGranted;

  const pushKeyboardStatus = useCallback(() => {
    const mode =
      imeReceiveRef.current && imeActiveRef.current
        ? ("ime" as const)
        : a11yReceiveRef.current && a11yGrantedRef.current
          ? ("a11y" as const)
          : ("none" as const);
    sessionRef.current?.sendKeyboardStatus(mode !== "none", mode);
  }, []);

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
      setA11yReceive(await isA11yReceiveEnabled());
      setA11yGranted(await isA11yServiceGranted());
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
      imeActiveRef.current = active;
      pushKeyboardStatus();
      log(active ? "Sync Keyboard active" : "Sync Keyboard inactive");
    });
    return () => sub.remove();
  }, [log, pushKeyboardStatus]);

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
          const safe = file.name.replace(/[^\w.-]+/g, "_") || "file.bin";
          const mime = file.mimeType || guessMime(safe);
          const safUri = appSettingsRef.current.incomingFilesUri.trim();
          if (safUri) {
            const created =
              await FileSystem.StorageAccessFramework.createFileAsync(
                safUri,
                safe,
                mime,
              );
            await FileSystem.StorageAccessFramework.writeAsStringAsync(
              created,
              file.dataBase64,
              { encoding: FileSystem.EncodingType.Base64 },
            );
            log(`saved file → ${created} (${file.size} B)`);
            return;
          }
          // Fallback: app-private Documents (not visible in Files without debug).
          const root = FileSystem.documentDirectory;
          if (!root) {
            log(`recv file ${file.name} (pick a save folder in Features)`);
            return;
          }
          const dir = `${root}involvex-Sync/`;
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          const path = `${dir}${safe}`;
          await FileSystem.writeAsStringAsync(path, file.dataBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          log(
            `saved to app storage → ${path} (${file.size} B) — pick an SD/folder in Features for Files access`,
          );
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
        if (imeReceiveRef.current && imeActiveRef.current) {
          const ok = await imeCommitText(text);
          log(ok ? `typed ${text.length} chars (IME)` : "IME commit failed");
          return;
        }
        if (a11yReceiveRef.current && a11yGrantedRef.current) {
          const ok = await a11yInjectText(text);
          log(ok ? `typed ${text.length} chars (a11y)` : "a11y inject failed");
          return;
        }
        log("keyboard ignored (enable IME or accessibility receive)");
      },
      onKeyboardKey: async (key) => {
        if (imeReceiveRef.current && imeActiveRef.current) {
          const ok = await imeSendKey(key);
          log(ok ? `key ${key} (IME)` : `key ${key} failed`);
          return;
        }
        if (a11yReceiveRef.current && a11yGrantedRef.current) {
          const ok = await a11yInjectKey(key);
          log(ok ? `key ${key} (a11y)` : `a11y key ${key} failed`);
          return;
        }
        log("keyboard key ignored");
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
        if (
          nextStatus.startsWith("connected") ||
          nextStatus.startsWith("Paired")
        ) {
          pushKeyboardStatus();
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
    pushKeyboardStatus,
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
        const shared = await readSharedFileBase64(
          file.uri,
          MAX_CHUNKED_FILE_BYTES,
        );
        s.sendFile({
          name: shared.name,
          mimeType: shared.mimeType,
          data: fromBase64(shared.dataBase64),
        });
        log(`sent file ${shared.name} (${shared.size} B)`);
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

  async function pickIncomingFolder(): Promise<void> {
    try {
      const permissions =
        await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permissions.granted || !permissions.directoryUri) {
        log("folder pick cancelled");
        return;
      }
      const next = await saveAppSettings({
        incomingFilesUri: permissions.directoryUri,
        incomingFilesLabel: labelFromSafUri(permissions.directoryUri),
      });
      setAppSettings(next);
      log(
        `incoming folder → ${next.incomingFilesLabel || next.incomingFilesUri}`,
      );
    } catch (e) {
      log(`folder pick failed: ${String(e)}`);
    }
  }

  async function clearIncomingFolder(): Promise<void> {
    const next = await saveAppSettings({
      incomingFilesUri: "",
      incomingFilesLabel: "",
    });
    setAppSettings(next);
    log("incoming folder cleared (app Documents fallback)");
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
      const size = asset.size ?? 0;
      if (size > MAX_CHUNKED_FILE_BYTES) {
        log(
          `file too large (max ${Math.floor(MAX_CHUNKED_FILE_BYTES / (1024 * 1024))} MiB)`,
        );
        return;
      }
      const dataBase64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Decode once, then stream chunks (avoid keeping full-file base64 + chunks[]).
      const data = fromBase64(dataBase64);
      s.sendFile({
        name: asset.name,
        mimeType: asset.mimeType || "application/octet-stream",
        data,
      });
      log(`sent file ${asset.name} (${data.byteLength} B)`);
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

  const value: SessionContextValue = {
    identity,
    peer,
    host,
    setHost,
    port,
    setPort,
    mode,
    setMode,
    pairPaste,
    setPairPaste,
    status,
    logs,
    pairingJson,
    nearby,
    history,
    showAdvanced,
    setShowAdvanced,
    showActivity,
    setShowActivity,
    pendingFiles,
    pairingBusy,
    pairingPhase,
    scanOpen,
    setScanOpen,
    cameraPermission,
    mirrorNotifs,
    listenerGranted,
    imeReceive,
    imeActive,
    a11yReceive,
    a11yGranted,
    finding,
    appSettings,
    setAppSettings,
    pwshCmd,
    setPwshCmd,
    cmdOutput,
    fp,
    connected,
    persistTransport,
    log,
    stopFindPhone,
    connect,
    disconnect,
    cancelPairing,
    pairWithNearby,
    pickIncomingFolder,
    clearIncomingFolder,
    pickAndSendFile,
    sendPendingFiles,
    runPwshOnPc,
    onPair,
    openScanner,
    onScanPayload,
    onUnpair,
    copyPairingJson,
    sendClipboardLink,
    resendHistory,
    pushKeyboardStatus,
    setImeReceive,
    setA11yReceive,
    setA11yGranted,
    setMirrorNotifs,
    setListenerGranted,
    imeReceiveRef,
    a11yReceiveRef,
    a11yGrantedRef,
    startMdnsBrowse,
    stopMdnsBrowse,
  };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
