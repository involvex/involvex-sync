import {
  DEFAULT_PORT,
  MAX_CHUNKED_FILE_BYTES,
  buildPairingPayload,
  deviceFingerprint,
  fromBase64,
  pairingQrText,
  parseAllowedUrl,
  parsePairingQr,
  type PairRequestPayload,
  type SecretKind,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable as enableAutostart } from "@tauri-apps/plugin-autostart";
import {
  readImage,
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
  compressClipboardImageBytes,
  encodeRgbaClipboardImage,
} from "./services/clipboardImage";
import {
  appendClipboardHistory,
  clearClipboardHistory,
  loadClipboardHistory,
  removeClipboardHistory,
  type ClipboardHistoryEntry,
} from "./services/clipboardHistory";
import {
  type StoredDeviceKeys,
  type StoredPeer,
  clearPeers,
  ensureLocalIdentity,
  loadPeers,
  removePeer,
  savePeer,
  toDeviceKeys,
} from "./services/identity";
import { RelayClient } from "./services/relay";
import { SyncSession } from "./services/session";
import {
  isSynced,
  loadLedger,
  markSynced,
  type FolderSyncLedger,
} from "./services/folderSyncLedger";
import {
  hasDriveFileId,
  isDriveSynced,
  loadDriveLedger,
  markDriveSynced,
  type DriveSyncLedger,
} from "./services/driveSyncLedger";
import {
  DRIVE_PAGE_SIZE_DEFAULT,
  formatDriveSize,
  formatDriveTime,
  listDriveFiles,
  normalizeDriveFolderId,
  openDriveFile,
  probeGws,
  uploadFileToDrive,
  type DriveFileEntry,
} from "./services/gwsDrive";
import {
  loadSettings,
  resolveThemeMode,
  saveSettings,
  type DesktopSettings,
} from "./services/settings";
import {
  describeAdbError,
  describeResolution,
  deviceLabel,
  isUsableForCapture,
  loadAdbDevices,
  resolveSerial,
  type AdbDevice,
} from "./services/adbDevices";
import {
  applyPeerNoteDelete,
  applyPeerNoteUpsert,
  clearPendingNoteOps,
  deleteLocalNote,
  loadNotes,
  loadPendingNoteOps,
  upsertLocalNote,
  type SyncNote,
} from "./services/notesStore";
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
} from "./services/secretsStore";
import "./App.css";

type SyncFileInfo = {
  path: string;
  relativeName: string;
  size: number;
  mtimeMs: number;
};

type SyncFilePayload = {
  name: string;
  mimeType: string;
  dataBase64: string;
  size: number;
  mtimeMs: number;
  relativeName: string;
};

type FolderSyncReady = {
  path: string;
  relativeName: string;
  size: number;
  mtimeMs: number;
};

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

/** Read-only Drive browser state (`gws drive files list`). */
type DriveBrowser = {
  /** Trail used by the "Up" button. Last entry is the current folder. */
  crumbs: Array<{ id?: string; name: string }>;
  /** Page token of the visible page (undefined = first page). */
  token?: string;
  /** Tokens of previous pages, for "Newer". */
  tokenStack: Array<string | undefined>;
  files: DriveFileEntry[];
  /** Drive ids already uploaded by folder sync, for the "synced" marker. */
  syncedIds: Set<string>;
  nextToken?: string;
  /** True once at least one page loaded successfully. */
  started: boolean;
  busy: boolean;
  error: string;
};

function emptyDriveBrowser(): DriveBrowser {
  return {
    crumbs: [],
    tokenStack: [],
    files: [],
    syncedIds: new Set(),
    started: false,
    busy: false,
    error: "",
  };
}

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

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

function isDriveFolder(entry: DriveFileEntry): boolean {
  return entry.mimeType === DRIVE_FOLDER_MIME;
}

export default function App() {
  const [identity, setIdentity] = useState<StoredDeviceKeys | null>(null);
  const [peers, setPeers] = useState<StoredPeer[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  /** Active pairing — the send target for clipboard/files/keys/notes. */
  const peer = useMemo(
    () => peers.find((p) => p.deviceId === activePeerId) ?? null,
    [peers, activePeerId],
  );
  const [lan, setLan] = useState<LanInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [pairPaste, setPairPaste] = useState("");
  const [sendUrl, setSendUrl] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [firewallMsg, setFirewallMsg] = useState<string>("");
  const [relayStatus, setRelayStatus] = useState<string>("off");
  const [relayEnabled, setRelayEnabled] = useState(false);
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
  const [adbDevices, setAdbDevices] = useState<AdbDevice[]>([]);
  const [adbDevicesBusy, setAdbDevicesBusy] = useState(false);
  const [adbDevicesError, setAdbDevicesError] = useState("");
  const [folderSyncStatus, setFolderSyncStatus] = useState("off");
  const [folderSyncLast, setFolderSyncLast] = useState("");
  const [driveSyncStatus, setDriveSyncStatus] = useState("off");
  const [driveSyncLast, setDriveSyncLast] = useState("");
  const [driveBrowser, setDriveBrowser] =
    useState<DriveBrowser>(emptyDriveBrowser);
  const driveLoadSeqRef = useRef(0);
  const [notes, setNotes] = useState<SyncNote[]>(() => loadNotes());
  const [secrets, setSecrets] = useState<StoredSecret[]>(() => loadSecrets());
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | undefined>();
  const [secretLabel, setSecretLabel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretKind, setSecretKind] = useState<SecretKind>("api_key");
  const [revealedSecrets, setRevealedSecrets] = useState<
    Record<string, string>
  >({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sessionRef = useRef<SyncSession | null>(null);
  const messageQueueRef = useRef<string[]>([]);
  const folderSyncLedgerRef = useRef<FolderSyncLedger>(loadLedger());
  const folderSyncQueueRef = useRef<FolderSyncReady[]>([]);
  const folderSyncBusyRef = useRef(false);
  const folderSyncRootRef = useRef(settings.folderSyncDir);
  const driveSyncLedgerRef = useRef<DriveSyncLedger>(loadDriveLedger());
  const driveSyncQueueRef = useRef<FolderSyncReady[]>([]);
  const driveSyncBusyRef = useRef(false);
  const adbLoadedRef = useRef(false);
  const sendClipboardRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const applyTheme = () => {
      const systemDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      const mode = resolveThemeMode(settings.theme, systemDark);
      document.documentElement.dataset.theme = mode;
    };
    applyTheme();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (settings.theme === "system") applyTheme();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.theme]);

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
    (
      text: string,
      direction: ClipboardHistoryEntry["direction"],
      opts?: { kind?: "text" | "image"; imagePath?: string },
    ) => {
      setHistory(appendClipboardHistory(text, direction, opts));
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
      onClipboardImage: async (file) => {
        try {
          const path = await invoke<string>("save_incoming_file", {
            name: file.name || `clipboard-${Date.now()}.jpg`,
            dataBase64: file.dataBase64,
            directory: null,
          });
          await writeImage(path);
          pushHistory("[Image]", "in", { kind: "image", imagePath: path });
          log("clipboard image updated from peer");
        } catch (e) {
          log(`clipboard image apply failed: ${String(e)}`);
        }
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
      onNoteUpsert: (note) => {
        setNotes(
          applyPeerNoteUpsert({
            id: note.id,
            title: note.title,
            body: note.body,
            updatedAt: note.updatedAt,
          }),
        );
        log("note synced from phone");
      },
      onNoteDelete: (note) => {
        setNotes(applyPeerNoteDelete(note.id, note.updatedAt));
        log("note deleted from phone");
      },
      onSecretUpsert: (secret) => {
        setSecrets(
          applyPeerSecretUpsert({
            id: secret.id,
            label: secret.meta.label,
            kind: secret.meta.kind,
            updatedAt: secret.updatedAt,
            nonce: secret.nonce,
            ciphertext: secret.ciphertext,
          }),
        );
        log("secret synced from phone");
      },
      onSecretDelete: (secret) => {
        setSecrets(applyPeerSecretDelete(secret.id, secret.updatedAt));
        log("secret deleted from phone");
      },
      onVaultKeyShare: async (keyHex) => {
        try {
          await acceptSharedVaultKey(keyHex);
          log("vault key received from phone");
        } catch (e) {
          log(`vault key share failed: ${String(e)}`);
        }
      },
      onLog: log,
    });
  }, [identity, log, notifyPairRequest, pushHistory, toast]);

  useEffect(() => {
    sessionRef.current = session;
    if (!session) return;
    const queued = messageQueueRef.current.splice(0);
    for (const raw of queued) {
      // Queued frames carry "<connId>\0<message>"; old plain entries still work.
      const sep = raw.indexOf("\u0000");
      if (sep > 0) {
        const connId = Number(raw.slice(0, sep));
        void session.handleIncomingRaw(
          raw.slice(sep + 1),
          Number.isFinite(connId) ? connId : undefined,
        );
      } else {
        void session.handleIncomingRaw(raw);
      }
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    session.setPeers(peers);
    session.setActivePeer(activePeerId);
  }, [session, peers, activePeerId]);

  // Load the adb device list once when the user opens the commands tab.
  useEffect(() => {
    if (tab !== "commands" || adbLoadedRef.current) return;
    adbLoadedRef.current = true;
    void refreshAdbDevices();
  }, [tab]);

  // Relay socket. Rebuilt when the paired peer changes because the room name
  // is `localId:peerId` — an old socket would sit in a room nobody else uses.
  useEffect(() => {
    if (!relayEnabled) {
      setRelay(null);
      setRelayStatus("off");
      return;
    }
    if (!identity) return;
    const client = new RelayClient(toDeviceKeys(identity), peer?.deviceId, {
      onMessage: (raw) => {
        void sessionRef.current?.handleIncomingRaw(raw);
      },
      onStatus: (s) => {
        setRelayStatus(s);
        log(s);
      },
    });
    client.connect();
    setRelay(client);
    return () => {
      client.disconnect();
      setRelay(null);
      setRelayStatus("off");
    };
    // `log` is stable (useCallback); listing it would re-create the socket
    // every time the log list re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayEnabled, identity, peer?.deviceId]);

  // Every encrypted frame can fall back to the relay once one is connected.
  useEffect(() => {
    sessionRef.current?.setRelaySender(
      relay ? (raw: string) => relay.send(raw) : null,
    );
  }, [relay, session]);

  useEffect(() => {
    void (async () => {
      const id = await ensureLocalIdentity("Windows-PC");
      setIdentity(id);
      const storedPeers = await loadPeers();
      setPeers(storedPeers);
      if (storedPeers.length > 0) setActivePeerId(storedPeers[0].deviceId);
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
        await listen<{ connId: number; message: string }>(
          "ws-message",
          (event) => {
            const current = sessionRef.current;
            if (current) {
              void current.handleIncomingRaw(
                event.payload.message,
                event.payload.connId,
              );
            } else {
              // Cold-start queue keeps the raw socket id with the frame.
              messageQueueRef.current.push(
                `${event.payload.connId}\u0000${event.payload.message}`,
              );
              if (messageQueueRef.current.length > 40) {
                messageQueueRef.current.shift();
              }
            }
          },
        ),
      );
      unsubs.push(
        await listen<{
          connected: boolean;
          addr?: string;
          connId?: number;
        }>("ws-peer", (e) => {
          log(
            e.payload.connected
              ? `peer connected ${e.payload.addr ?? ""}`
              : "peer disconnected",
          );
          if (e.payload.connected) {
            toast("Phone connected", "ok");
          } else {
            toast("Phone disconnected", "info");
            // Drop socket→device mappings for the socket that just went away.
            if (e.payload.connId !== undefined) {
              sessionRef.current?.forgetConn(e.payload.connId);
            }
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
              // Clipboard path never auto-opens URLs.
              await s.sendClipboard(text);
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
  const liveRef = useRef(live);
  liveRef.current = live;

  const flushNotesAndSecrets = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !liveRef.current) return;
    try {
      const notePending = loadPendingNoteOps();
      const noteLeft = [];
      for (const op of notePending) {
        try {
          if (op.op === "upsert") await s.sendNoteUpsert(op.note);
          else await s.sendNoteDelete({ id: op.id, updatedAt: op.updatedAt });
        } catch {
          noteLeft.push(op);
        }
      }
      clearPendingNoteOps(noteLeft);

      const secretPending = loadPendingSecretOps();
      const secretLeft = [];
      for (const op of secretPending) {
        try {
          if (op.op === "vault_key_share") {
            await s.sendVaultKeyShare(op.keyHex);
          } else if (op.op === "upsert") {
            await s.sendSecretUpsert({
              id: op.secret.id,
              updatedAt: op.secret.updatedAt,
              ciphertext: op.secret.ciphertext,
              nonce: op.secret.nonce,
              meta: { label: op.secret.label, kind: op.secret.kind },
            });
          } else {
            await s.sendSecretDelete({ id: op.id, updatedAt: op.updatedAt });
          }
        } catch {
          secretLeft.push(op);
        }
      }
      clearPendingSecretOps(secretLeft);
    } catch (e) {
      log(`notes/secrets flush failed: ${String(e)}`);
    }
  }, [log]);

  useEffect(() => {
    if (live) void flushNotesAndSecrets();
  }, [live, flushNotesAndSecrets]);
  const keyboardReady = settings.sendKeysToPhone && live && phoneKeyboardActive;

  const pushQueueBounded = (
    q: FolderSyncReady[],
    item: FolderSyncReady,
  ): boolean => {
    if (
      q.some(
        (x) =>
          x.path === item.path &&
          x.size === item.size &&
          x.mtimeMs === item.mtimeMs,
      )
    ) {
      return false;
    }
    if (q.length >= 40) q.shift();
    q.push(item);
    return true;
  };

  const enqueueFolderSync = useCallback(
    (item: FolderSyncReady) => {
      if (!settingsRef.current.folderSyncEnabled) return;
      if (
        isSynced(
          folderSyncLedgerRef.current,
          item.relativeName,
          item.size,
          item.mtimeMs,
        )
      ) {
        return;
      }
      if (item.size > MAX_CHUNKED_FILE_BYTES) {
        log(`folder sync skip ${item.relativeName} (${item.size} B > cap)`);
        return;
      }
      if (pushQueueBounded(folderSyncQueueRef.current, item)) {
        setFolderSyncStatus(`queued ${folderSyncQueueRef.current.length}`);
      }
    },
    [log],
  );

  const enqueueDriveSync = useCallback((item: FolderSyncReady) => {
    if (!settingsRef.current.driveSyncEnabled) return;
    if (
      isDriveSynced(
        driveSyncLedgerRef.current,
        item.relativeName,
        item.size,
        item.mtimeMs,
      )
    ) {
      return;
    }
    if (pushQueueBounded(driveSyncQueueRef.current, item)) {
      setDriveSyncStatus(`queued ${driveSyncQueueRef.current.length}`);
    }
  }, []);

  const enqueueWatchItem = useCallback(
    (item: FolderSyncReady) => {
      enqueueFolderSync(item);
      enqueueDriveSync(item);
    },
    [enqueueDriveSync, enqueueFolderSync],
  );

  const drainFolderSyncQueue = useCallback(async () => {
    if (folderSyncBusyRef.current) return;
    if (!settingsRef.current.folderSyncEnabled) return;
    folderSyncBusyRef.current = true;
    try {
      while (folderSyncQueueRef.current.length > 0) {
        if (!liveRef.current || !sessionRef.current) {
          setFolderSyncStatus(
            `queued ${folderSyncQueueRef.current.length} (offline)`,
          );
          break;
        }
        const item = folderSyncQueueRef.current[0];
        if (
          isSynced(
            folderSyncLedgerRef.current,
            item.relativeName,
            item.size,
            item.mtimeMs,
          )
        ) {
          folderSyncQueueRef.current.shift();
          continue;
        }
        setFolderSyncStatus(`sending ${item.relativeName}`);
        try {
          const root = folderSyncRootRef.current;
          const payload = await invoke<SyncFilePayload>("read_sync_file", {
            path: item.path,
            root,
          });
          if (payload.size > MAX_CHUNKED_FILE_BYTES) {
            log(`folder sync skip ${payload.relativeName} (too large)`);
            folderSyncQueueRef.current.shift();
            continue;
          }
          const data = fromBase64(payload.dataBase64);
          await sessionRef.current.sendFile({
            name: payload.name,
            mimeType: payload.mimeType || "application/octet-stream",
            data,
          });
          folderSyncLedgerRef.current = markSynced(
            folderSyncLedgerRef.current,
            payload.relativeName,
            payload.size,
            payload.mtimeMs,
          );
          folderSyncQueueRef.current.shift();
          setFolderSyncLast(payload.relativeName);
          log(`folder sync → ${payload.relativeName} (${payload.size} B)`);
          toast(`Synced ${payload.relativeName}`, "ok");
        } catch (e) {
          log(`folder sync failed ${item.relativeName}: ${String(e)}`);
          setFolderSyncStatus(
            `error · queued ${folderSyncQueueRef.current.length}`,
          );
          break;
        }
      }
      if (folderSyncQueueRef.current.length === 0) {
        setFolderSyncStatus(
          settingsRef.current.folderSyncEnabled ? "watching" : "off",
        );
      }
    } finally {
      folderSyncBusyRef.current = false;
    }
  }, [log, toast]);

  const drainDriveSyncQueue = useCallback(async () => {
    if (driveSyncBusyRef.current) return;
    if (!settingsRef.current.driveSyncEnabled) return;
    driveSyncBusyRef.current = true;
    try {
      while (driveSyncQueueRef.current.length > 0) {
        const item = driveSyncQueueRef.current[0];
        if (
          isDriveSynced(
            driveSyncLedgerRef.current,
            item.relativeName,
            item.size,
            item.mtimeMs,
          )
        ) {
          driveSyncQueueRef.current.shift();
          continue;
        }
        setDriveSyncStatus(`uploading ${item.relativeName}`);
        try {
          const result = await uploadFileToDrive({
            path: item.path,
            name: item.relativeName,
            parentId: settingsRef.current.driveSyncFolderId,
          });
          if (!result.ok) {
            log(`drive sync failed ${item.relativeName}: ${result.detail}`);
            setDriveSyncStatus(
              `error · queued ${driveSyncQueueRef.current.length}`,
            );
            break;
          }
          driveSyncLedgerRef.current = markDriveSynced(
            driveSyncLedgerRef.current,
            item.relativeName,
            item.size,
            item.mtimeMs,
            result.fileId,
          );
          driveSyncQueueRef.current.shift();
          setDriveSyncLast(item.relativeName);
          log(`drive sync → ${item.relativeName}`);
          toast(`Drive: ${item.relativeName}`, "ok");
        } catch (e) {
          log(`drive sync failed ${item.relativeName}: ${String(e)}`);
          setDriveSyncStatus(
            `error · queued ${driveSyncQueueRef.current.length}`,
          );
          break;
        }
      }
      if (driveSyncQueueRef.current.length === 0) {
        setDriveSyncStatus(
          settingsRef.current.driveSyncEnabled ? "watching" : "off",
        );
      }
    } finally {
      driveSyncBusyRef.current = false;
    }
  }, [log, toast]);

  const scanFolderSync = useCallback(async () => {
    const dir = settingsRef.current.folderSyncDir.trim();
    if (!dir) return;
    try {
      const files = await invoke<SyncFileInfo[]>("list_sync_files", { dir });
      for (const f of files) {
        enqueueWatchItem({
          path: f.path,
          relativeName: f.relativeName,
          size: f.size,
          mtimeMs: f.mtimeMs,
        });
      }
      void drainFolderSyncQueue();
      void drainDriveSyncQueue();
    } catch (e) {
      log(`folder sync scan: ${String(e)}`);
    }
  }, [drainDriveSyncQueue, drainFolderSyncQueue, enqueueWatchItem, log]);

  const onProbeDrive = useCallback(async () => {
    setDriveSyncStatus("probing…");
    const probe = await probeGws();
    if (probe.status === "ok") {
      setDriveSyncStatus(
        settingsRef.current.driveSyncEnabled ? "watching" : "connected",
      );
      toast("gws Drive OK", "ok");
      log(`gws probe: ${probe.detail}`);
    } else if (probe.status === "missing") {
      setDriveSyncStatus("gws missing");
      toast("gws not on PATH", "err");
      log(`gws probe missing: ${probe.detail}`);
    } else if (probe.status === "auth") {
      setDriveSyncStatus("auth needed");
      toast("gws auth needed — run gws auth login -s drive", "err");
      log(`gws probe auth: ${probe.detail}`);
    } else {
      setDriveSyncStatus("error");
      toast(probe.detail, "err");
      log(`gws probe error: ${probe.detail}`);
    }
  }, [log, toast]);

  /**
   * Load one Drive listing page. `crumbs` is the folder path (last = current).
   * Overlapping calls are dropped so a slow response cannot overwrite a newer
   * one (folder drill-down and page flips race otherwise).
   */
  const loadDrivePage = useCallback(
    async (
      crumbs: DriveBrowser["crumbs"],
      token: string | undefined,
      tokenStack: Array<string | undefined>,
    ) => {
      const seq = ++driveLoadSeqRef.current;
      const folderId =
        crumbs.length > 0 ? crumbs[crumbs.length - 1].id : undefined;
      setDriveBrowser((prev) => ({ ...prev, busy: true, error: "" }));
      const result = await listDriveFiles({
        folderId,
        pageSize: DRIVE_PAGE_SIZE_DEFAULT,
        pageToken: token,
      });
      if (seq !== driveLoadSeqRef.current) return;
      if (!result.ok) {
        setDriveBrowser((prev) => ({
          ...prev,
          busy: false,
          error: result.detail,
        }));
        log(`drive list: ${result.detail}`);
        toast(result.detail.slice(0, 120), "err");
        return;
      }
      const syncedIds = new Set<string>();
      for (const entry of result.files) {
        if (hasDriveFileId(driveSyncLedgerRef.current, entry.id)) {
          syncedIds.add(entry.id);
        }
      }
      setDriveBrowser({
        crumbs,
        ...(token ? { token } : {}),
        tokenStack,
        files: result.files,
        syncedIds,
        ...(result.nextPageToken ? { nextToken: result.nextPageToken } : {}),
        started: true,
        busy: false,
        error: "",
      });
      log(`drive list ${folderId ?? "root"}: ${result.files.length} item(s)`);
    },
    [log, toast],
  );

  const onOpenDriveBrowser = useCallback(() => {
    const raw = settingsRef.current.driveSyncFolderId.trim();
    const folderId = normalizeDriveFolderId(raw);
    if (raw && !folderId) {
      toast("Invalid Drive folder id — showing My Drive root", "err");
      log(`drive folder id invalid: ${raw.slice(0, 60)}`);
      void loadDrivePage([], undefined, []);
      return;
    }
    void loadDrivePage(
      folderId ? [{ id: folderId, name: "sync folder" }] : [],
      undefined,
      [],
    );
  }, [loadDrivePage, log, toast]);

  const onDriveRoot = useCallback(() => {
    void loadDrivePage([], undefined, []);
  }, [loadDrivePage]);

  const onRefreshDriveBrowser = useCallback(() => {
    void loadDrivePage(
      driveBrowser.crumbs,
      driveBrowser.token,
      driveBrowser.tokenStack,
    );
  }, [
    driveBrowser.crumbs,
    driveBrowser.token,
    driveBrowser.tokenStack,
    loadDrivePage,
  ]);

  const onDriveListOrRefresh = useCallback(() => {
    if (driveBrowser.started) {
      onRefreshDriveBrowser();
      return;
    }
    onOpenDriveBrowser();
  }, [driveBrowser.started, onOpenDriveBrowser, onRefreshDriveBrowser]);

  const onDriveUp = useCallback(() => {
    void loadDrivePage(driveBrowser.crumbs.slice(0, -1), undefined, []);
  }, [driveBrowser.crumbs, loadDrivePage]);

  const onDriveEnter = useCallback(
    (entry: DriveFileEntry) => {
      void loadDrivePage(
        [...driveBrowser.crumbs, { id: entry.id, name: entry.name }],
        undefined,
        [],
      );
    },
    [driveBrowser.crumbs, loadDrivePage],
  );

  const onDriveNewer = useCallback(() => {
    if (driveBrowser.tokenStack.length === 0) return;
    const stack = driveBrowser.tokenStack.slice(0, -1);
    const token = driveBrowser.tokenStack[driveBrowser.tokenStack.length - 1];
    void loadDrivePage(driveBrowser.crumbs, token, stack);
  }, [driveBrowser.crumbs, driveBrowser.tokenStack, loadDrivePage]);

  const onDriveOlder = useCallback(() => {
    if (!driveBrowser.nextToken) return;
    void loadDrivePage(driveBrowser.crumbs, driveBrowser.nextToken, [
      ...driveBrowser.tokenStack,
      driveBrowser.token,
    ]);
  }, [
    driveBrowser.crumbs,
    driveBrowser.nextToken,
    driveBrowser.token,
    driveBrowser.tokenStack,
    loadDrivePage,
  ]);

  const onOpenDriveEntry = useCallback(
    async (entry: DriveFileEntry) => {
      try {
        await openDriveFile(entry.id);
        log(`opened drive file ${entry.name}`);
      } catch (e) {
        log(`open drive file failed: ${String(e)}`);
        toast("Could not open in browser", "err");
      }
    },
    [log, toast],
  );

  const onUseDriveFolderAsSync = useCallback(() => {
    const current = driveBrowser.crumbs[driveBrowser.crumbs.length - 1];
    const next = saveSettings({ driveSyncFolderId: current?.id ?? "" });
    setSettings(next);
    log(`drive sync folder → ${current?.id || "My Drive root"}`);
    toast(
      current?.id
        ? "Sync folder set to this Drive folder"
        : "Sync folder = My Drive root",
      "ok",
    );
  }, [driveBrowser.crumbs, log, toast]);

  useEffect(() => {
    let cancelled = false;
    const watchEnabled =
      settings.folderSyncEnabled || settings.driveSyncEnabled;
    void (async () => {
      if (!watchEnabled) {
        try {
          await invoke("stop_folder_sync");
        } catch {
          /* ignore */
        }
        if (!cancelled) {
          if (!settings.folderSyncEnabled) setFolderSyncStatus("off");
          if (!settings.driveSyncEnabled) setDriveSyncStatus("off");
        }
        return;
      }
      const dir =
        settings.folderSyncDir.trim() || "I:\\Downloads\\Involvex-Sync";
      folderSyncRootRef.current = dir;
      try {
        const root = await invoke<string>("start_folder_sync", { dir });
        if (cancelled) return;
        folderSyncRootRef.current = root;
        if (settings.folderSyncEnabled) setFolderSyncStatus("watching");
        if (settings.driveSyncEnabled) setDriveSyncStatus("watching");
        log(
          `folder watch ${root} (phone=${settings.folderSyncEnabled} drive=${settings.driveSyncEnabled})`,
        );
        await scanFolderSync();
      } catch (e) {
        if (!cancelled) {
          if (settings.folderSyncEnabled) setFolderSyncStatus("error");
          if (settings.driveSyncEnabled) setDriveSyncStatus("error");
          log(`folder sync start: ${String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    settings.folderSyncEnabled,
    settings.driveSyncEnabled,
    settings.folderSyncDir,
    log,
    scanFolderSync,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<FolderSyncReady>("folder-sync-ready", (e) => {
      enqueueWatchItem(e.payload);
      void drainFolderSyncQueue();
      void drainDriveSyncQueue();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [drainDriveSyncQueue, drainFolderSyncQueue, enqueueWatchItem]);

  useEffect(() => {
    if (!live) return;
    void drainFolderSyncQueue();
  }, [live, drainFolderSyncQueue]);

  useEffect(() => {
    if (!settings.driveSyncEnabled) return;
    void drainDriveSyncQueue();
  }, [settings.driveSyncEnabled, drainDriveSyncQueue]);

  async function onAcceptPair(): Promise<void> {
    if (!session || !pendingPair) return;
    const next: StoredPeer = {
      deviceId: pendingPair.device.deviceId,
      name: pendingPair.device.name,
      deviceType: pendingPair.device.type,
      ed25519PublicKey: pendingPair.device.ed25519PublicKey,
      x25519PublicKey: pendingPair.device.x25519PublicKey,
    };
    // Persist first: accepting without saving leaves the phone paired to a
    // desktop that forgets it on restart.
    try {
      await savePeer(next);
    } catch (e) {
      log(`save peer failed: ${String(e)}`);
      toast("Could not save pairing", "err");
      return;
    }
    try {
      await session.acceptPair(
        pendingPair,
        lan?.ip ?? undefined,
        lan?.port || DEFAULT_PORT,
      );
    } catch (e) {
      // The request arrived on a socket that has since died; the saved peer
      // stays, but the phone never learns it was accepted.
      log(`accept failed: ${String(e)}`);
      toast("Could not reach the device to accept", "err");
      return;
    }
    upsertPeer(next, true);
    setPendingPair(null);
    log(`accepted ${next.name}`);
    toast(`Paired with ${next.name}`, "ok");
  }

  async function onRejectPair(): Promise<void> {
    if (!session || !pendingPair) return;
    await session.rejectPair(pendingPair, "user rejected");
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
    upsertPeer(next, true);
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
      // Clipboard sync never auto-opens URLs — peer clipboard + history only.
      await session.sendClipboard(text);
      pushHistory(text, "out");
      log("sent clipboard text");
      toast("Clipboard sent", "ok");
    } catch (e) {
      log(`send clipboard: ${String(e)}`);
      toast("Send failed", "err");
    }
  }
  sendClipboardRef.current = onSendClipboard;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("tray-send-clipboard", () => {
      void sendClipboardRef.current();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Auto clipboard sync: poll OS clipboard while Live + setting on.
  useEffect(() => {
    if (!settings.autoClipboardSync) return;
    let lastText = "";
    let lastImageKey = "";
    let seeded = false;
    let busy = false;
    let stopped = false;

    const snapshotKeys = async (): Promise<void> => {
      try {
        lastText = (await readText()) ?? "";
      } catch {
        lastText = "";
      }
      if (settingsRef.current.autoClipboardImages) {
        try {
          const img = await readImage();
          const size = await img.size();
          const rgba = await img.rgba();
          lastImageKey = `${size.width}x${size.height}:${rgba.byteLength}:${rgba[0]}:${rgba[rgba.length - 1]}`;
        } catch {
          lastImageKey = "";
        }
      }
      seeded = true;
    };

    const tick = async () => {
      if (stopped || busy) return;
      if (!liveRef.current || !sessionRef.current) return;
      const cfg = settingsRef.current;
      if (!cfg.autoClipboardSync) return;
      if (!seeded) {
        await snapshotKeys();
        return;
      }
      busy = true;
      try {
        let text = "";
        try {
          text = (await readText()) ?? "";
        } catch {
          text = "";
        }
        if (text && text !== lastText) {
          lastText = text;
          lastImageKey = "";
          await sessionRef.current.sendClipboard(text);
          pushHistory(text, "out");
          log("auto clipboard text → phone");
          return;
        }
        if (!cfg.autoClipboardImages) return;
        try {
          const img = await readImage();
          const size = await img.size();
          const rgba = await img.rgba();
          const key = `${size.width}x${size.height}:${rgba.byteLength}:${rgba[0]}:${rgba[rgba.length - 1]}`;
          if (key === lastImageKey) return;
          lastImageKey = key;
          lastText = "";
          const encoded = await encodeRgbaClipboardImage(
            rgba,
            size.width,
            size.height,
          );
          await sessionRef.current.sendClipboardImage(encoded);
          pushHistory("[Image]", "out", { kind: "image" });
          log("auto clipboard image → phone");
        } catch {
          /* no image on clipboard */
        }
      } catch (e) {
        log(`auto clipboard: ${String(e)}`);
      } finally {
        busy = false;
      }
    };

    void snapshotKeys();
    const id = window.setInterval(() => {
      void tick();
    }, 450);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [
    settings.autoClipboardSync,
    settings.autoClipboardImages,
    log,
    pushHistory,
  ]);

  /** Add or refresh one pairing in the list; `active` makes it the send target. */
  function upsertPeer(next: StoredPeer, active = true): void {
    setPeers((prev) => {
      const idx = prev.findIndex((p) => p.deviceId === next.deviceId);
      const list =
        idx >= 0
          ? prev.map((p, i) => (i === idx ? { ...p, ...next } : p))
          : [...prev, next];
      return list;
    });
    if (active) setActivePeerId(next.deviceId);
  }

  async function onUnpair(deviceId?: string): Promise<void> {
    const target = deviceId ?? activePeerId;
    if (!target) return;
    // Look up the socket before removing the peer — that drops the mapping.
    const connId = session?.connIdFor(target);
    await removePeer(target);
    if (connId !== undefined) {
      try {
        await invoke("ws_close", { connId });
      } catch (e) {
        log(`close socket: ${String(e)}`);
      }
    }
    setPeers((prev) => {
      const list = prev.filter((p) => p.deviceId !== target);
      setActivePeerId((current) =>
        current === target ? (list[0]?.deviceId ?? null) : current,
      );
      return list;
    });
    session?.removePeer(target);
    log(`unpaired ${target}`);
    toast("Device removed", "info");
  }

  async function onUnpairAll(): Promise<void> {
    await clearPeers();
    try {
      const conns = await invoke<Array<{ connId: number }>>("ws_conns");
      for (const c of conns) {
        try {
          await invoke("ws_close", { connId: c.connId });
        } catch {
          /* already gone */
        }
      }
    } catch (e) {
      log(`close sockets: ${String(e)}`);
    }
    setPeers([]);
    setActivePeerId(null);
    session?.clearPeer();
    log("all peers cleared");
    toast("All devices removed", "info");
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
    const next = !relayEnabled;
    setRelayEnabled(next);
    log(next ? "relay starting…" : "relay stopped");
  }

  async function onSendLinkRelayAware(): Promise<void> {
    if (!session) return;
    const url = parseAllowedUrl(sendUrl);
    if (!url) {
      log("url not allowed");
      toast("URL not allowed", "err");
      return;
    }
    // sendBody already falls back to the relay when LAN is down.
    try {
      await session.sendShareUrl(url);
      pushHistory(url, "out");
      log(`sent link ${url}`);
      toast("Link sent", "ok");
    } catch (e) {
      log(`send failed: ${String(e)}`);
      toast("Send failed — phone not connected", "err");
    }
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
      if (entry.kind === "image" && entry.imagePath) {
        const dataBase64 = await invoke<string>("read_file_base64", {
          path: entry.imagePath,
        });
        const encoded = await compressClipboardImageBytes(
          fromBase64(dataBase64),
          entry.imagePath.toLowerCase().endsWith(".png")
            ? "image/png"
            : "image/jpeg",
        );
        await session.sendClipboardImage(encoded);
        pushHistory("[Image]", "out", {
          kind: "image",
          imagePath: entry.imagePath,
        });
        log("resent clipboard image");
        toast("Image resent", "ok");
        return;
      }
      await session.sendClipboard(entry.text);
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

  /**
   * Snapshot the adb device list and pick the serial to target. Precedence:
   * saved setting → single connected device → explicit pick required.
   */
  async function resolveAdbTarget(): Promise<{
    serial: string | null;
    message: string;
    stale: boolean;
  }> {
    let devices: AdbDevice[];
    try {
      devices = await loadAdbDevices();
    } catch (e) {
      return { serial: null, message: describeAdbError(e), stale: false };
    }
    setAdbDevices(devices);
    const res = resolveSerial(devices, {
      preferred: settingsRef.current.adbSerial,
    });
    if (res.staleSetting) {
      log("adb: saved serial unavailable — re-resolving device");
    }
    return {
      serial: res.serial,
      message: describeResolution(res),
      stale: res.staleSetting,
    };
  }

  async function refreshAdbDevices(): Promise<void> {
    setAdbDevicesBusy(true);
    try {
      const devices = await loadAdbDevices();
      setAdbDevices(devices);
      setAdbDevicesError("");
    } catch (e) {
      setAdbDevices([]);
      setAdbDevicesError(describeAdbError(e));
    } finally {
      setAdbDevicesBusy(false);
    }
  }

  async function onRunAdb(): Promise<void> {
    if (!adbCmd.trim()) {
      toast("Empty adb command", "err");
      return;
    }
    const target = await resolveAdbTarget();
    if (!target.serial) {
      setCmdOutput(target.message);
      toast(target.message, "err");
      return;
    }
    try {
      const result = await invoke<ShellResult>("run_adb_shell", {
        command: adbCmd.trim(),
        timeoutMs: 30_000,
        serial: target.serial,
      });
      setCmdOutput(
        [result.stdout, result.stderr].filter(Boolean).join("\n") ||
          `(exit ${result.exitCode ?? "?"})`,
      );
      log(`adb ${result.ok ? "ok" : "fail"} -s ${target.serial}`);
      toast(result.ok ? "ADB ok" : "ADB failed", result.ok ? "ok" : "err");
    } catch (e) {
      const msg = describeAdbError(e);
      setCmdOutput(msg);
      log(`adb: ${msg}`);
      toast(msg, "err");
    }
  }

  async function onScreenshot(): Promise<void> {
    if (screenshotBusy) return;
    setScreenshotBusy(true);
    try {
      const target = await resolveAdbTarget();
      if (!target.serial) {
        throw new Error(target.message || "no adb device");
      }
      const path = await invoke<string>("adb_screencap", {
        timeoutMs: 20_000,
        serial: target.serial,
      });
      await writeImage(path);
      log(`screenshot → clipboard (${path})`);
      toast("Screenshot copied to clipboard", "ok");
      const cfg = settingsRef.current;
      if (
        liveRef.current &&
        sessionRef.current &&
        cfg.autoClipboardSync &&
        cfg.autoClipboardImages
      ) {
        try {
          const dataBase64 = await invoke<string>("read_file_base64", {
            path,
          });
          const encoded = await compressClipboardImageBytes(
            fromBase64(dataBase64),
            "image/png",
          );
          await sessionRef.current.sendClipboardImage(encoded);
          pushHistory("[Image]", "out", { kind: "image", imagePath: path });
          log("screenshot → phone clipboard");
        } catch (e) {
          log(`screenshot sync: ${String(e)}`);
        }
      }
    } catch (e) {
      const msg = describeAdbError(e);
      log(`screenshot: ${msg}`);
      toast(msg, "err");
      setCmdOutput(msg);
    } finally {
      setScreenshotBusy(false);
    }
  }

  /** Select value: fall back to Auto when the saved serial isn't connected. */
  const adbSelectedSerial =
    settings.adbSerial &&
    adbDevices.some((d) => d.serial === settings.adbSerial)
      ? settings.adbSerial
      : "";
  const adbStaleSetting =
    Boolean(settings.adbSerial) &&
    !adbDevicesBusy &&
    adbDevices.length > 0 &&
    !adbDevices.some((d) => d.serial === settings.adbSerial);

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
                : peers.length > 1
                  ? `${peers.length} devices · offline`
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
              <h2>Paired devices</h2>
              {peers.length === 0 ? (
                <p className="muted">
                  No devices yet — wait for a LAN pair request or paste JSON.
                </p>
              ) : (
                <>
                  <label className="stack">
                    Active device
                    <select
                      value={activePeerId ?? ""}
                      onChange={(e) => {
                        const id = e.target.value;
                        setActivePeerId(id || null);
                        const chosen = peers.find((p) => p.deviceId === id);
                        if (chosen) log(`target ${chosen.name}`);
                      }}
                    >
                      {peers.map((p) => (
                        <option key={p.deviceId} value={p.deviceId}>
                          {p.name} ({p.deviceType})
                        </option>
                      ))}
                    </select>
                  </label>
                  <ul className="peer-list">
                    {peers.map((p) => {
                      const isActive = p.deviceId === activePeerId;
                      return (
                        <li
                          key={p.deviceId}
                          className={isActive ? "on" : undefined}
                        >
                          <div>
                            <strong>{p.name}</strong> ({p.deviceType})
                            {isActive ? (
                              <span className="tag">active</span>
                            ) : null}
                            <p className="mono small">{p.deviceId}</p>
                            <p className="muted small">
                              {live && isActive
                                ? "Connected"
                                : "Offline — Connect on this device"}
                            </p>
                          </div>
                          <div className="row">
                            {!isActive ? (
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => setActivePeerId(p.deviceId)}
                              >
                                Use
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => void onUnpair(p.deviceId)}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void onUnpairAll()}
                  >
                    Forget all devices
                  </button>
                </>
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
            <hr className="divider" />
            <h3>Folder sync → phone</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.folderSyncEnabled}
                onChange={(e) => {
                  const next = saveSettings({
                    folderSyncEnabled: e.target.checked,
                  });
                  setSettings(next);
                  log(
                    next.folderSyncEnabled
                      ? "folder sync on"
                      : "folder sync off",
                  );
                }}
              />
              Watch PC folder and auto-send new files
            </label>
            <label className="stack">
              Sync folder
              <input
                value={settings.folderSyncDir}
                onChange={(e) => {
                  const next = saveSettings({
                    folderSyncDir: e.target.value,
                  });
                  setSettings(next);
                }}
                placeholder="I:\Downloads\Involvex-Sync"
                disabled={!settings.folderSyncEnabled}
              />
            </label>
            <p className="muted small">
              Status: {folderSyncStatus}
              {folderSyncLast ? ` · last ${folderSyncLast}` : ""}
            </p>
            <div className="row">
              <button
                type="button"
                className="ghost"
                disabled={!settings.folderSyncEnabled}
                onClick={() => void scanFolderSync()}
              >
                Scan now
              </button>
            </div>
            <p className="muted small">
              One-way PC → phone. Phone must have a save folder picked (SAF).
              Subfolders are flattened as <code>sub__file.ext</code>. Max{" "}
              {Math.floor(MAX_CHUNKED_FILE_BYTES / (1024 * 1024))} MiB per file.
            </p>
            <hr className="divider" />
            <h3>Folder sync → Google Drive</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.driveSyncEnabled}
                onChange={(e) => {
                  const next = saveSettings({
                    driveSyncEnabled: e.target.checked,
                  });
                  setSettings(next);
                  log(
                    next.driveSyncEnabled ? "drive sync on" : "drive sync off",
                  );
                }}
              />
              Upload new files from the sync folder via gws
            </label>
            <label className="stack">
              Drive folder ID (optional)
              <input
                value={settings.driveSyncFolderId}
                onChange={(e) => {
                  const next = saveSettings({
                    driveSyncFolderId: e.target.value,
                  });
                  setSettings(next);
                }}
                onBlur={(e) => {
                  // Accept a pasted Drive URL; keep free-text entry as-is.
                  const id = normalizeDriveFolderId(e.target.value);
                  const next = saveSettings({ driveSyncFolderId: id });
                  setSettings(next);
                }}
                placeholder="Leave empty for My Drive root"
                disabled={!settings.driveSyncEnabled}
              />
            </label>
            <p className="muted small">
              Status: {driveSyncStatus}
              {driveSyncLast ? ` · last ${driveSyncLast}` : ""}
            </p>
            <div className="row">
              <button
                type="button"
                className="ghost"
                onClick={() => void onProbeDrive()}
              >
                Test gws connection
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!settings.driveSyncEnabled}
                onClick={() => void scanFolderSync()}
              >
                Scan now
              </button>
            </div>
            <p className="muted small">
              Requires <code>gws</code> on PATH and{" "}
              <code>gws auth login -s drive</code>. Uses the same sync folder as
              phone sync; either sink can run alone or together.
            </p>
            <hr className="divider" />
            <h3>Drive files</h3>
            <p className="muted small">
              Read-only listing of My Drive via{" "}
              <code>gws drive files list</code>.{" "}
              {driveBrowser.crumbs.length > 0
                ? `In: ${driveBrowser.crumbs[driveBrowser.crumbs.length - 1].name}`
                : "My Drive root"}
            </p>
            <div className="row">
              <button
                type="button"
                className="ghost"
                disabled={driveBrowser.busy}
                onClick={onDriveListOrRefresh}
              >
                {driveBrowser.busy ? "Loading…" : "List / refresh"}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={driveBrowser.busy || driveBrowser.crumbs.length === 0}
                onClick={onDriveUp}
              >
                Up
              </button>
              <button
                type="button"
                className="ghost"
                disabled={driveBrowser.busy}
                onClick={onDriveRoot}
              >
                Root
              </button>
              {driveBrowser.tokenStack.length > 0 ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={driveBrowser.busy}
                  onClick={onDriveNewer}
                >
                  Newer
                </button>
              ) : null}
              {driveBrowser.nextToken ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={driveBrowser.busy}
                  onClick={onDriveOlder}
                >
                  Older
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                disabled={driveBrowser.busy}
                onClick={onUseDriveFolderAsSync}
              >
                Use as sync folder
              </button>
            </div>
            {driveBrowser.error ? (
              <p className="muted small">Error: {driveBrowser.error}</p>
            ) : null}
            {driveBrowser.files.length > 0 ? (
              <ul className="history" aria-busy={driveBrowser.busy}>
                {driveBrowser.files.map((entry) => {
                  const folder = isDriveFolder(entry);
                  const meta = [
                    folder ? "folder" : formatDriveSize(entry.size),
                    formatDriveTime(entry.modifiedTime),
                    driveBrowser.syncedIds.has(entry.id) ? "synced" : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="linkish"
                        title={entry.id}
                        disabled={driveBrowser.busy}
                        onClick={() =>
                          folder
                            ? onDriveEnter(entry)
                            : void onOpenDriveEntry(entry)
                        }
                      >
                        {entry.name}
                      </button>
                      <span className="muted small drive-meta">{meta}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted small">
                {driveBrowser.busy
                  ? "Fetching…"
                  : driveBrowser.started
                    ? "This folder is empty."
                    : "No files listed yet — press “List / refresh”."}
              </p>
            )}
            <p className="muted small">
              Read-only: opens files in the Drive web UI. Folder rows drill in;
              page size {DRIVE_PAGE_SIZE_DEFAULT}.
            </p>
            <hr className="divider" />
            <h3>Notes</h3>
            <p className="muted small">
              Quick notes sync to the phone when connected
              {live ? "." : " (offline — queued)."}
            </p>
            <label className="stack">
              Title
              <input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="Untitled"
              />
            </label>
            <label className="stack">
              Note
              <textarea
                rows={3}
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Write a quick note…"
              />
            </label>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  if (!noteTitle.trim() && !noteBody.trim()) return;
                  const {
                    notes: next,
                    note,
                    pending,
                  } = upsertLocalNote({
                    id: editingNoteId,
                    title: noteTitle.trim() || "Untitled",
                    body: noteBody,
                  });
                  setNotes(next);
                  setNoteTitle("");
                  setNoteBody("");
                  setEditingNoteId(undefined);
                  const s = sessionRef.current;
                  if (s && live) {
                    void s
                      .sendNoteUpsert(note)
                      .then(() =>
                        clearPendingNoteOps(
                          pending.filter(
                            (p) =>
                              !(p.op === "upsert" && p.note.id === note.id) &&
                              !(p.op === "delete" && p.id === note.id),
                          ),
                        ),
                      )
                      .catch((e) => log(`note sync queued: ${String(e)}`));
                  }
                }}
              >
                {editingNoteId ? "Update note" : "Save note"}
              </button>
              {editingNoteId ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setEditingNoteId(undefined);
                    setNoteTitle("");
                    setNoteBody("");
                  }}
                >
                  Cancel
                </button>
              ) : null}
            </div>
            <ul className="history">
              {notes.map((n) => (
                <li key={n.id}>
                  <strong>{n.title}</strong>
                  <p className="muted small">{n.body || "(empty)"}</p>
                  <div className="row">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setEditingNoteId(n.id);
                        setNoteTitle(n.title);
                        setNoteBody(n.body);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        const { notes: next, pending } = deleteLocalNote(n.id);
                        setNotes(next);
                        const del = pending.find(
                          (p) => p.op === "delete" && p.id === n.id,
                        );
                        const s = sessionRef.current;
                        if (s && live && del && del.op === "delete") {
                          void s
                            .sendNoteDelete({
                              id: del.id,
                              updatedAt: del.updatedAt,
                            })
                            .then(() =>
                              clearPendingNoteOps(
                                pending.filter(
                                  (p) => !(p.op === "delete" && p.id === n.id),
                                ),
                              ),
                            )
                            .catch((e) =>
                              log(`note delete queued: ${String(e)}`),
                            );
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {notes.length === 0 ? (
              <p className="muted small">No notes yet.</p>
            ) : null}

            <hr className="divider" />
            <h3>Secrets</h3>
            <p className="muted small">
              API keys / passwords encrypted at rest. Unlock uses Windows
              Credential Manager (signed-in user). Ciphertext syncs to the
              phone.
            </p>
            <div className="row">
              {vaultUnlocked ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    lockVault();
                    setVaultUnlocked(false);
                    setRevealedSecrets({});
                  }}
                >
                  Lock
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const ok = await unlockVault();
                      setVaultUnlocked(ok && isVaultUnlocked());
                      if (!ok) toast("Could not unlock vault", "err");
                    })();
                  }}
                >
                  Unlock
                </button>
              )}
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void (async () => {
                    try {
                      const { keyHex, created } = await ensureVaultKey();
                      setVaultUnlocked(true);
                      if (created) {
                        queueVaultKeyShare(keyHex);
                        const s = sessionRef.current;
                        if (s && live) {
                          await s.sendVaultKeyShare(keyHex);
                          clearPendingSecretOps(
                            loadPendingSecretOps().filter(
                              (p) => p.op !== "vault_key_share",
                            ),
                          );
                        }
                      }
                      toast("Vault ready", "ok");
                    } catch (e) {
                      toast(`Vault: ${String(e)}`, "err");
                    }
                  })();
                }}
              >
                Enable vault
              </button>
            </div>
            {vaultUnlocked ? (
              <>
                <label className="stack">
                  Label
                  <input
                    value={secretLabel}
                    onChange={(e) => setSecretLabel(e.target.value)}
                    placeholder="OpenAI / GitHub token"
                  />
                </label>
                <label className="stack">
                  Kind
                  <select
                    value={secretKind}
                    onChange={(e) =>
                      setSecretKind(e.target.value as SecretKind)
                    }
                  >
                    <option value="api_key">api_key</option>
                    <option value="password">password</option>
                    <option value="token">token</option>
                    <option value="text">text</option>
                  </select>
                </label>
                <label className="stack">
                  Value
                  <input
                    type="password"
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="off"
                  />
                </label>
                <div className="row">
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        if (!secretLabel.trim() || !secretValue.trim()) return;
                        try {
                          if (!(await hasVaultKey())) {
                            const { keyHex, created } = await ensureVaultKey();
                            if (created) queueVaultKeyShare(keyHex);
                          } else if (!isVaultUnlocked()) {
                            const ok = await unlockVault();
                            if (!ok) throw new Error("vault locked");
                          }
                          setVaultUnlocked(true);
                          const {
                            secrets: next,
                            secret,
                            pending,
                          } = upsertLocalSecret({
                            label: secretLabel.trim(),
                            kind: secretKind,
                            value: secretValue,
                          });
                          setSecrets(next);
                          setSecretLabel("");
                          setSecretValue("");
                          const s = sessionRef.current;
                          if (s && live) {
                            const keyPending = pending.find(
                              (p) => p.op === "vault_key_share",
                            );
                            if (
                              keyPending &&
                              keyPending.op === "vault_key_share"
                            ) {
                              await s.sendVaultKeyShare(keyPending.keyHex);
                            }
                            await s.sendSecretUpsert({
                              id: secret.id,
                              updatedAt: secret.updatedAt,
                              ciphertext: secret.ciphertext,
                              nonce: secret.nonce,
                              meta: {
                                label: secret.label,
                                kind: secret.kind,
                              },
                            });
                            clearPendingSecretOps(
                              pending.filter(
                                (p) =>
                                  !(
                                    p.op === "vault_key_share" ||
                                    (p.op === "upsert" &&
                                      p.secret.id === secret.id) ||
                                    (p.op === "delete" && p.id === secret.id)
                                  ),
                              ),
                            );
                          }
                        } catch (e) {
                          toast(String(e), "err");
                        }
                      })();
                    }}
                  >
                    Save secret
                  </button>
                </div>
              </>
            ) : (
              <p className="muted small">
                Unlock to add or reveal values. Labels stay visible while
                locked.
              </p>
            )}
            <ul className="history">
              {secrets.map((sec) => (
                <li key={sec.id}>
                  <strong>
                    {sec.label} · {sec.kind}
                  </strong>
                  <p className="muted small mono">
                    {revealedSecrets[sec.id] ?? "••••••••"}
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        void (async () => {
                          try {
                            if (!isVaultUnlocked()) {
                              const ok = await unlockVault();
                              if (!ok) throw new Error("vault locked");
                              setVaultUnlocked(true);
                            }
                            const value = revealSecretValue(sec);
                            setRevealedSecrets((prev) => ({
                              ...prev,
                              [sec.id]: value,
                            }));
                          } catch (e) {
                            toast(String(e), "err");
                          }
                        })();
                      }}
                    >
                      Reveal
                    </button>
                    {revealedSecrets[sec.id] ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          const value = revealedSecrets[sec.id];
                          if (value) void writeText(value);
                          toast("Copied", "ok");
                        }}
                      >
                        Copy
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        const { secrets: next, pending } = deleteLocalSecret(
                          sec.id,
                        );
                        setSecrets(next);
                        setRevealedSecrets((prev) => {
                          const n = { ...prev };
                          delete n[sec.id];
                          return n;
                        });
                        const del = pending.find(
                          (p) => p.op === "delete" && p.id === sec.id,
                        );
                        const s = sessionRef.current;
                        if (s && live && del && del.op === "delete") {
                          void s
                            .sendSecretDelete({
                              id: del.id,
                              updatedAt: del.updatedAt,
                            })
                            .then(() =>
                              clearPendingSecretOps(
                                pending.filter(
                                  (p) =>
                                    !(p.op === "delete" && p.id === sec.id),
                                ),
                              ),
                            )
                            .catch((e) =>
                              log(`secret delete queued: ${String(e)}`),
                            );
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {secrets.length === 0 ? (
              <p className="muted small">No secrets yet.</p>
            ) : null}
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
              <label className="stack">
                Device
                <div className="row">
                  <select
                    value={adbSelectedSerial}
                    onChange={(e) => {
                      const serial = e.target.value;
                      const next = saveSettings({ adbSerial: serial });
                      setSettings(next);
                    }}
                    disabled={adbDevicesBusy}
                  >
                    <option value="">Auto (single connected device)</option>
                    {adbDevices.map((d) => (
                      <option key={d.serial} value={d.serial}>
                        {deviceLabel(d)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ghost"
                    disabled={adbDevicesBusy}
                    onClick={() => void refreshAdbDevices()}
                  >
                    {adbDevicesBusy ? "…" : "Refresh"}
                  </button>
                </div>
              </label>
              {adbDevicesError ? (
                <p className="status-err small">{adbDevicesError}</p>
              ) : adbStaleSetting ? (
                <p className="muted small">
                  Saved serial {settings.adbSerial} is not connected — using
                  auto-detection.
                </p>
              ) : null}
              {adbDevices.length > 0 && !adbDevicesBusy ? (
                <p className="muted small">
                  {adbDevices.filter(isUsableForCapture).length} of{" "}
                  {adbDevices.length} device(s) ready
                </p>
              ) : null}
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
                      onClick={() => {
                        if (entry.kind === "image" && entry.imagePath) {
                          void writeImage(entry.imagePath);
                        } else {
                          void writeText(entry.text);
                        }
                      }}
                      title="Copy"
                    >
                      [{entry.direction}]{entry.kind === "image" ? " 🖼 " : " "}
                      {entry.text.slice(0, 120)}
                      {entry.text.length > 120 ? "…" : ""}
                    </button>
                    <button
                      type="button"
                      disabled={!live}
                      onClick={() => void resendHistory(entry)}
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        setHistory(removeClipboardHistory(entry.id))
                      }
                    >
                      Remove
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
              <p className="muted small">Theme</p>
              <div className="theme-row">
                {(
                  [
                    ["system", "System"],
                    ["light", "Light"],
                    ["dark", "Dark"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={settings.theme === id ? "active" : "ghost"}
                    onClick={() => {
                      const next = saveSettings({ theme: id });
                      setSettings(next);
                      log(`theme → ${id}`);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.autoClipboardSync}
                  onChange={(e) => {
                    const next = saveSettings({
                      autoClipboardSync: e.target.checked,
                    });
                    setSettings(next);
                    log(
                      next.autoClipboardSync
                        ? "auto clipboard sync on"
                        : "auto clipboard sync off",
                    );
                  }}
                />
                Auto sync clipboard
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.autoClipboardImages}
                  disabled={!settings.autoClipboardSync}
                  onChange={(e) => {
                    const next = saveSettings({
                      autoClipboardImages: e.target.checked,
                    });
                    setSettings(next);
                    log(
                      next.autoClipboardImages
                        ? "clipboard images on"
                        : "clipboard images off",
                    );
                  }}
                />
                Include images / screenshots
              </label>
              <p className="muted small">
                Phone must also enable auto sync. Images stay under 2 MiB.
              </p>
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
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.folderSyncEnabled}
                  onChange={(e) => {
                    const next = saveSettings({
                      folderSyncEnabled: e.target.checked,
                    });
                    setSettings(next);
                  }}
                />
                Folder sync (PC → phone)
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.driveSyncEnabled}
                  onChange={(e) => {
                    const next = saveSettings({
                      driveSyncEnabled: e.target.checked,
                    });
                    setSettings(next);
                  }}
                />
                Folder sync (PC → Google Drive via gws)
              </label>
              <label className="stack">
                Outbound sync folder
                <input
                  value={settings.folderSyncDir}
                  onChange={(e) => {
                    const next = saveSettings({
                      folderSyncDir: e.target.value,
                    });
                    setSettings(next);
                  }}
                  placeholder="I:\Downloads\Involvex-Sync"
                />
              </label>
              <label className="stack">
                Drive folder ID
                <input
                  value={settings.driveSyncFolderId}
                  onChange={(e) => {
                    const next = saveSettings({
                      driveSyncFolderId: e.target.value,
                    });
                    setSettings(next);
                  }}
                  onBlur={(e) => {
                    const id = normalizeDriveFolderId(e.target.value);
                    setSettings(saveSettings({ driveSyncFolderId: id }));
                  }}
                  placeholder="Empty = My Drive root"
                />
              </label>
              <p className="muted small">
                Leave incoming blank for default:{" "}
                {defaultIncomingDir || "Downloads/involvex-Sync"}. Close or
                minimize hides to the tray (tray menu: Open, Send clipboard,
                Quit). Pair requests always notify. Drive sync needs{" "}
                <code>gws</code> on PATH.
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
