import {
  DEFAULT_PORT,
  MAX_CHUNKED_FILE_BYTES,
  MAX_CLIPBOARD_IMAGE_BYTES,
  buildPairingPayload,
  deviceFingerprint,
  fromBase64,
  looksLikeUrl,
  pairingQrText,
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
  addClipboardImageListener,
  addClipboardTextListener,
  compressClipboardImageNative,
  setClipboardAutoEnabled,
  setClipboardImeActive,
  setClipboardIncludeImages,
  setNativeClipboardImage,
} from "../modules/invx-clipboard/src";
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
import {
  isTermuxInstalled,
  startTermuxRunCommand,
  TERMUX_SETUP_HINT,
} from "../modules/invx-termux/src";
import {
  appendClipboardHistory,
  loadClipboardHistory,
  removeClipboardHistory,
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
  defaultMobileAppSettings,
  loadAppSettings,
  saveAppSettings,
  type MobileAppSettings,
} from "./appSettings";
import {
  applyPeerNoteDelete,
  applyPeerNoteUpsert,
  clearPendingNoteOps,
  deleteLocalNote,
  loadNotes,
  loadPendingNoteOps,
  upsertLocalNote,
  type SyncNote,
} from "./notesStore";
import {
  acceptSharedVaultKey,
  applyPeerSecretDelete,
  applyPeerSecretUpsert,
  clearPendingSecretOps,
  deleteLocalSecret,
  ensureVaultKey,
  hasVaultKey,
  isVaultUnlocked,
  loadPendingSecretOps,
  loadSecrets,
  lockVault,
  queueVaultKeyShare,
  revealSecretValue,
  unlockVault,
  upsertLocalSecret,
  type StoredSecret,
} from "./secretsStore";
import { loadTransportPrefs, saveTransportPrefs } from "./settings";
import { MobileSession } from "./session";
import { allowlistedRunSpec } from "./termux";
import { type TransportMode, defaultTransport } from "./transport";
import type { SecretKind } from "@involvex/protocol";

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
  removeHistory: (id: string) => Promise<void>;
  testTermux: () => Promise<void>;
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
  hydrated: boolean;
  notes: SyncNote[];
  secrets: StoredSecret[];
  vaultUnlocked: boolean;
  saveNote: (input: {
    id?: string;
    title: string;
    body: string;
  }) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  unlockSecrets: () => Promise<boolean>;
  lockSecrets: () => void;
  enableSecretsVault: () => Promise<boolean>;
  saveSecret: (input: {
    id?: string;
    label: string;
    kind: SecretKind;
    value: string;
  }) => Promise<void>;
  removeSecret: (id: string) => Promise<void>;
  revealSecret: (secret: StoredSecret) => Promise<string>;
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
  const [appSettings, setAppSettings] = useState<MobileAppSettings>(() => ({
    ...defaultMobileAppSettings,
  }));
  const [pwshCmd, setPwshCmd] = useState("");
  const [cmdOutput, setCmdOutput] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [notes, setNotes] = useState<SyncNote[]>([]);
  const [secrets, setSecrets] = useState<StoredSecret[]>([]);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
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
    async (
      text: string,
      direction: ClipboardHistoryEntry["direction"],
      opts?: { kind?: "text" | "image"; imageUri?: string },
    ) => {
      const next = await appendClipboardHistory(text, direction, opts);
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
      const settings = await loadAppSettings();
      setAppSettings(settings);
      await setClipboardAutoEnabled(settings.autoClipboardSync);
      await setClipboardIncludeImages(settings.autoClipboardImages);
      setNotes(await loadNotes());
      setSecrets(await loadSecrets());
      setVaultUnlocked(isVaultUnlocked());
      setHydrated(true);
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
      void setClipboardImeActive(active);
      pushKeyboardStatus();
      log(active ? "Sync Keyboard active" : "Sync Keyboard inactive");
    });
    return () => sub.remove();
  }, [log, pushKeyboardStatus]);

  useEffect(() => {
    void setClipboardAutoEnabled(appSettings.autoClipboardSync);
    void setClipboardIncludeImages(appSettings.autoClipboardImages);
  }, [appSettings.autoClipboardSync, appSettings.autoClipboardImages]);

  useEffect(() => {
    if (!appSettings.autoClipboardSync) return;
    const textSub = addClipboardTextListener((text) => {
      const s = sessionRef.current;
      if (!s?.isOpen || !text.trim()) return;
      try {
        // URLs stay on clipboard_update (history only) — do not auto-open.
        s.sendClipboard(text);
        void pushHistory(text, "out");
        log("auto clipboard text → PC");
      } catch (e) {
        log(`auto clipboard: ${String(e)}`);
      }
    });
    const imageSub = addClipboardImageListener((image) => {
      if (!appSettingsRef.current.autoClipboardImages) return;
      const s = sessionRef.current;
      if (!s?.isOpen) return;
      void (async () => {
        try {
          let payload = image;
          if (image.size > MAX_CLIPBOARD_IMAGE_BYTES) {
            const compressed = await compressClipboardImageNative(
              image.dataBase64,
              MAX_CLIPBOARD_IMAGE_BYTES,
            );
            if (!compressed) {
              log("auto clipboard image too large");
              return;
            }
            payload = compressed;
          }
          s.sendClipboardImage({
            name: payload.name,
            mimeType: payload.mimeType,
            dataBase64: payload.dataBase64,
          });
          await pushHistory("[Image]", "out", { kind: "image" });
          log("auto clipboard image → PC");
        } catch (e) {
          log(`auto clipboard image: ${String(e)}`);
        }
      })();
    });
    return () => {
      textSub.remove();
      imageSub.remove();
    };
  }, [appSettings.autoClipboardSync, log, pushHistory]);

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
        // History + notification only — never auto-open the browser.
        await pushHistory(url, "in");
        await openUrlViaNotification(url);
      },
      onClipboard: async (text) => {
        await Clipboard.setStringAsync(text);
        await pushHistory(text, "in");
        log("clipboard set from desktop");
      },
      onClipboardImage: async (file) => {
        try {
          const root = FileSystem.cacheDirectory;
          let imageUri: string | undefined;
          if (root) {
            const path = `${root}clip-in-${Date.now()}.jpg`;
            await FileSystem.writeAsStringAsync(path, file.dataBase64, {
              encoding: FileSystem.EncodingType.Base64,
            });
            imageUri = path;
          }
          try {
            await Clipboard.setImageAsync(file.dataBase64);
          } catch {
            await setNativeClipboardImage(file.dataBase64, file.mimeType);
          }
          await pushHistory("[Image]", "in", { kind: "image", imageUri });
          log("clipboard image set from desktop");
        } catch (e) {
          log(`clipboard image apply failed: ${String(e)}`);
        }
      },
      onTermuxOpenUrl: async (url) => {
        try {
          const result = await startTermuxRunCommand(
            allowlistedRunSpec({ command: "open-url", url }),
          );
          log(
            result.ok
              ? `termux open-url ${url}`
              : `termux open-url failed: ${result.errmsg || result.stderr || `exit ${result.exitCode}`}`,
          );
          // Always land in history; open only via notification tap.
          await pushHistory(url, "in");
          if (!result.ok) {
            await openUrlViaNotification(url);
          }
        } catch (e) {
          log(`termux open-url failed: ${String(e)}`);
          await pushHistory(url, "in");
          await openUrlViaNotification(url);
        }
      },
      onTermuxClipboardSet: async (text) => {
        try {
          const result = await startTermuxRunCommand(
            allowlistedRunSpec({ command: "clipboard-set", text }),
          );
          if (result.ok) {
            await pushHistory(text, "in");
            log("termux clipboard-set");
            return;
          }
          log(
            `termux clipboard denied — using Expo clipboard (${result.errmsg || result.stderr || `exit ${result.exitCode}`})`,
          );
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
          const result = await startTermuxRunCommand(
            allowlistedRunSpec({
              command: "shell",
              script: request.command,
            }),
          );
          const stderrParts = [
            result.stderr,
            result.errmsg,
            result.ok ? "" : TERMUX_SETUP_HINT,
          ].filter(Boolean);
          sessionRef.current?.sendRemoteCommandResult({
            requestId: request.requestId,
            ok: result.ok,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: stderrParts.join("\n"),
          });
          log(
            result.ok
              ? `termux ok: ${request.command}`
              : `termux fail: ${result.errmsg || result.stderr || `exit ${result.exitCode}`}`,
          );
        } catch (e) {
          const msg = `${String(e)}\n${TERMUX_SETUP_HINT}`;
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
      onNoteUpsert: async (note) => {
        setNotes(
          await applyPeerNoteUpsert({
            id: note.id,
            title: note.title,
            body: note.body,
            updatedAt: note.updatedAt,
          }),
        );
        log("note synced from PC");
      },
      onNoteDelete: async (note) => {
        setNotes(await applyPeerNoteDelete(note.id, note.updatedAt));
        log("note deleted from PC");
      },
      onSecretUpsert: async (secret) => {
        setSecrets(
          await applyPeerSecretUpsert({
            id: secret.id,
            label: secret.meta.label,
            kind: secret.meta.kind,
            updatedAt: secret.updatedAt,
            nonce: secret.nonce,
            ciphertext: secret.ciphertext,
          }),
        );
        log("secret synced from PC");
      },
      onSecretDelete: async (secret) => {
        setSecrets(await applyPeerSecretDelete(secret.id, secret.updatedAt));
        log("secret deleted from PC");
      },
      onVaultKeyShare: async (keyHex) => {
        try {
          await acceptSharedVaultKey(keyHex);
          log("vault key received from PC");
        } catch (e) {
          log(`vault key share failed: ${String(e)}`);
        }
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

  const flushNotesAndSecrets = useCallback(async () => {
    const s = sessionRef.current;
    if (!s?.isOpen) return;
    try {
      const notePending = await loadPendingNoteOps();
      const noteLeft = [];
      for (const op of notePending) {
        try {
          if (op.op === "upsert") {
            s.sendNoteUpsert(op.note);
          } else {
            s.sendNoteDelete({ id: op.id, updatedAt: op.updatedAt });
          }
        } catch {
          noteLeft.push(op);
        }
      }
      await clearPendingNoteOps(noteLeft);

      const secretPending = await loadPendingSecretOps();
      const secretLeft = [];
      for (const op of secretPending) {
        try {
          if (op.op === "vault_key_share") {
            s.sendVaultKeyShare(op.keyHex);
          } else if (op.op === "upsert") {
            s.sendSecretUpsert({
              id: op.secret.id,
              updatedAt: op.secret.updatedAt,
              ciphertext: op.secret.ciphertext,
              nonce: op.secret.nonce,
              meta: { label: op.secret.label, kind: op.secret.kind },
            });
          } else {
            s.sendSecretDelete({ id: op.id, updatedAt: op.updatedAt });
          }
        } catch {
          secretLeft.push(op);
        }
      }
      await clearPendingSecretOps(secretLeft);
    } catch (e) {
      log(`notes/secrets flush failed: ${String(e)}`);
    }
  }, [log]);

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
    if (text) {
      try {
        // Clipboard path never auto-opens URLs — history + peer clipboard only.
        sessionRef.current?.sendClipboard(text);
        await pushHistory(text, "out");
        log("sent clipboard text");
      } catch (e) {
        log(`send failed: ${String(e)}`);
      }
      return;
    }
    try {
      const img = await Clipboard.getImageAsync({ format: "jpeg" });
      if (!img?.data) {
        log("clipboard empty");
        return;
      }
      let dataBase64 = img.data;
      let mimeType = "image/jpeg";
      let name = `clipboard-${Date.now()}.jpg`;
      const approx = Math.floor((dataBase64.length * 3) / 4);
      if (approx > MAX_CLIPBOARD_IMAGE_BYTES) {
        const compressed = await compressClipboardImageNative(
          dataBase64,
          MAX_CLIPBOARD_IMAGE_BYTES,
        );
        if (!compressed) {
          log("clipboard image too large");
          return;
        }
        dataBase64 = compressed.dataBase64;
        mimeType = compressed.mimeType;
        name = compressed.name;
      }
      sessionRef.current?.sendClipboardImage({
        name,
        mimeType,
        dataBase64,
      });
      await pushHistory("[Image]", "out", { kind: "image" });
      log("sent clipboard image");
    } catch (e) {
      log(`send image failed: ${String(e)}`);
    }
  }

  async function resendHistory(entry: ClipboardHistoryEntry): Promise<void> {
    try {
      if (entry.kind === "image" && entry.imageUri) {
        const dataBase64 = await FileSystem.readAsStringAsync(entry.imageUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        let payload = {
          name: `clipboard-${Date.now()}.jpg`,
          mimeType: "image/jpeg",
          dataBase64,
        };
        const approx = Math.floor((dataBase64.length * 3) / 4);
        if (approx > MAX_CLIPBOARD_IMAGE_BYTES) {
          const compressed = await compressClipboardImageNative(
            dataBase64,
            MAX_CLIPBOARD_IMAGE_BYTES,
          );
          if (!compressed) {
            log("history image too large");
            return;
          }
          payload = {
            name: compressed.name,
            mimeType: compressed.mimeType,
            dataBase64: compressed.dataBase64,
          };
        }
        sessionRef.current?.sendClipboardImage(payload);
        await pushHistory("[Image]", "out", {
          kind: "image",
          imageUri: entry.imageUri,
        });
        log("resent clipboard image");
        return;
      }
      sessionRef.current?.sendClipboard(entry.text);
      await pushHistory(entry.text, "out");
      log("resent from history");
    } catch (e) {
      log(`resend failed: ${String(e)}`);
    }
  }

  async function removeHistory(id: string): Promise<void> {
    setHistory(await removeClipboardHistory(id));
  }

  async function testTermux(): Promise<void> {
    try {
      if (!(await isTermuxInstalled())) {
        log(
          `Termux missing — Sync targets com.involvex.termux_app (InVx / I:/dev/termux-app). ${TERMUX_SETUP_HINT}`,
        );
        return;
      }
      log("Termux target: com.involvex.termux_app (InVxTermux)");
      const result = await startTermuxRunCommand(
        allowlistedRunSpec({
          command: "shell",
          script:
            'echo "involvex-termux-ok"; command -v termux-toast >/dev/null && termux-toast "involvex Sync ok" || echo "termux-toast missing (pkg install termux-api)"',
        }),
      );
      const meta = [result.termuxPackage, result.commandPath]
        .filter(Boolean)
        .join(" · ");
      if (result.ok) {
        log(
          `Termux test ok: ${(result.stdout || "").trim() || "exit 0"}${meta ? ` [${meta}]` : ""}`,
        );
      } else {
        log(
          `Termux test fail exit ${result.exitCode}: ${result.errmsg || result.stderr || "(no detail)"}${meta ? ` [${meta}]` : ""}\n${TERMUX_SETUP_HINT}`,
        );
      }
    } catch (e) {
      log(`Termux test: ${String(e)}\n${TERMUX_SETUP_HINT}`);
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

  useEffect(() => {
    if (connected) void flushNotesAndSecrets();
  }, [connected, flushNotesAndSecrets]);

  const saveNote = useCallback(
    async (input: { id?: string; title: string; body: string }) => {
      const { notes: next, note, pending } = await upsertLocalNote(input);
      setNotes(next);
      const s = sessionRef.current;
      if (s?.isOpen) {
        try {
          s.sendNoteUpsert(note);
          await clearPendingNoteOps(
            pending.filter(
              (p) =>
                !(p.op === "upsert" && p.note.id === note.id) &&
                !(p.op === "delete" && p.id === note.id),
            ),
          );
        } catch (e) {
          log(`note sync queued: ${String(e)}`);
        }
      }
    },
    [log],
  );

  const removeNote = useCallback(
    async (id: string) => {
      const { notes: next, pending } = await deleteLocalNote(id);
      setNotes(next);
      const del = pending.find((p) => p.op === "delete" && p.id === id);
      const s = sessionRef.current;
      if (s?.isOpen && del && del.op === "delete") {
        try {
          s.sendNoteDelete({ id: del.id, updatedAt: del.updatedAt });
          await clearPendingNoteOps(
            pending.filter((p) => !(p.op === "delete" && p.id === id)),
          );
        } catch (e) {
          log(`note delete queued: ${String(e)}`);
        }
      }
    },
    [log],
  );

  const unlockSecrets = useCallback(async () => {
    const ok = await unlockVault();
    setVaultUnlocked(ok && isVaultUnlocked());
    return ok;
  }, []);

  const lockSecrets = useCallback(() => {
    lockVault();
    setVaultUnlocked(false);
  }, []);

  const enableSecretsVault = useCallback(async () => {
    try {
      const { keyHex, created } = await ensureVaultKey();
      setVaultUnlocked(true);
      if (created) {
        await queueVaultKeyShare(keyHex);
        const s = sessionRef.current;
        if (s?.isOpen) {
          try {
            s.sendVaultKeyShare(keyHex);
            const pending = await loadPendingSecretOps();
            await clearPendingSecretOps(
              pending.filter((p) => p.op !== "vault_key_share"),
            );
          } catch {
            /* queued */
          }
        }
      }
      return true;
    } catch (e) {
      log(`vault enable failed: ${String(e)}`);
      return false;
    }
  }, [log]);

  const saveSecret = useCallback(
    async (input: {
      id?: string;
      label: string;
      kind: SecretKind;
      value: string;
    }) => {
      if (!(await hasVaultKey())) {
        const ok = await enableSecretsVault();
        if (!ok) throw new Error("vault not ready");
      } else if (!isVaultUnlocked()) {
        const ok = await unlockVault();
        if (!ok) throw new Error("vault locked");
        setVaultUnlocked(true);
      }
      const { secrets: next, secret, pending } = await upsertLocalSecret(input);
      setSecrets(next);
      setVaultUnlocked(true);
      const s = sessionRef.current;
      if (s?.isOpen) {
        try {
          // Share vault key once if peer may not have it yet.
          const keyPending = pending.find((p) => p.op === "vault_key_share");
          if (keyPending && keyPending.op === "vault_key_share") {
            s.sendVaultKeyShare(keyPending.keyHex);
          }
          s.sendSecretUpsert({
            id: secret.id,
            updatedAt: secret.updatedAt,
            ciphertext: secret.ciphertext,
            nonce: secret.nonce,
            meta: { label: secret.label, kind: secret.kind },
          });
          await clearPendingSecretOps(
            pending.filter((p) =>
              p.op === "vault_key_share" ||
              (p.op === "upsert" && p.secret.id === secret.id) ||
              (p.op === "delete" && p.id === secret.id)
                ? false
                : true,
            ),
          );
        } catch (e) {
          log(`secret sync queued: ${String(e)}`);
        }
      }
    },
    [enableSecretsVault, log],
  );

  const removeSecret = useCallback(
    async (id: string) => {
      const { secrets: next, pending } = await deleteLocalSecret(id);
      setSecrets(next);
      const del = pending.find((p) => p.op === "delete" && p.id === id);
      const s = sessionRef.current;
      if (s?.isOpen && del && del.op === "delete") {
        try {
          s.sendSecretDelete({ id: del.id, updatedAt: del.updatedAt });
          await clearPendingSecretOps(
            pending.filter((p) => !(p.op === "delete" && p.id === id)),
          );
        } catch (e) {
          log(`secret delete queued: ${String(e)}`);
        }
      }
    },
    [log],
  );

  const revealSecret = useCallback(async (secret: StoredSecret) => {
    if (!isVaultUnlocked()) {
      const ok = await unlockVault();
      if (!ok) throw new Error("vault locked");
      setVaultUnlocked(true);
    }
    return Promise.resolve(revealSecretValue(secret));
  }, []);

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
    removeHistory,
    testTermux,
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
    hydrated,
    notes,
    secrets,
    vaultUnlocked,
    saveNote,
    removeNote,
    unlockSecrets,
    lockSecrets,
    enableSecretsVault,
    saveSecret,
    removeSecret,
    revealSecret,
  };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
