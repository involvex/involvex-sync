import {
  type DeviceKeys,
  type DeviceType,
  type KeyboardKeyId,
  DEFAULT_PORT,
  LoopGuard,
  type MessageBody,
  createMessageBody,
  type NoteDeletePayload,
  type NoteUpsertPayload,
  type PairAcceptPayload,
  type PeerPublicKeys,
  type RemoteShell,
  type SecretDeletePayload,
  type SecretUpsertPayload,
  FILE_CHUNK_BYTES,
  ChunkAssembler,
  assertClipboardImageSize,
  assertSendableSize,
  buildPairRequest,
  bytesToHex,
  chunkCountForSize,
  clipboardUpdateBody,
  decryptFrame,
  encryptFrame,
  fileAbortBody,
  fileChunkBody,
  fileDoneBody,
  fileOfferBody,
  fileTransferBody,
  fromBase64,
  hashBytes,
  iterateFileChunks,
  keyboardStatusBody,
  noteDeleteBody,
  noteUpsertBody,
  notificationMirrorBody,
  parseAllowedUrl,
  parseFrame,
  parsePairHandshake,
  randomBytes,
  remoteCommandBody,
  remoteCommandResultBody,
  secretDeleteBody,
  secretUpsertBody,
  serializeFrame,
  shareUrlBody,
  toBase64,
  vaultKeyShareBody,
} from "@involvex/protocol";
import type { StoredDeviceKeys, StoredPeer } from "./identity";
import { toDeviceKeys } from "./identity";
import { type TransportConfig, resolveWsUrl } from "./transport";

/** Reconnect backoff: 2.5s → 5s → 10s … capped at 60s. */
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 8;

/** One live socket per paired host. */
type PeerConn = {
  peer: StoredPeer;
  keys: PeerPublicKeys;
  transport: TransportConfig;
  ws: WebSocket | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

export type RemoteCommandRequest = {
  requestId: string;
  shell: RemoteShell;
  command: string;
  timeoutMs?: number;
};

export type RemoteCommandResult = {
  requestId: string;
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
};

export type SessionHandlers = {
  onShareUrl: (url: string, from: string) => void | Promise<void>;
  onClipboard: (text: string, from: string) => void | Promise<void>;
  onClipboardImage?: (
    file: {
      name: string;
      mimeType: string;
      dataBase64: string;
      size: number;
      hash: string;
    },
    from: string,
  ) => void | Promise<void>;
  onTermuxOpenUrl?: (url: string, from: string) => void | Promise<void>;
  onTermuxClipboardSet?: (text: string, from: string) => void | Promise<void>;
  onFileTransfer?: (
    file: {
      name: string;
      mimeType: string;
      dataBase64: string;
      size: number;
    },
    from: string,
  ) => void | Promise<void>;
  onKeyboardText?: (text: string) => void | Promise<void>;
  onKeyboardKey?: (key: KeyboardKeyId) => void | Promise<void>;
  onFindPhone?: (durationMs: number) => void | Promise<void>;
  onRemoteCommand?: (
    request: RemoteCommandRequest,
    from: string,
  ) => void | Promise<void>;
  onRemoteCommandResult?: (
    result: RemoteCommandResult,
    from: string,
  ) => void | Promise<void>;
  onPairAccept?: (accept: PairAcceptPayload) => void | Promise<void>;
  onPairReject?: (reason?: string) => void | Promise<void>;
  onNoteUpsert?: (
    note: NoteUpsertPayload,
    from: string,
  ) => void | Promise<void>;
  onNoteDelete?: (
    note: NoteDeletePayload,
    from: string,
  ) => void | Promise<void>;
  onSecretUpsert?: (
    secret: SecretUpsertPayload,
    from: string,
  ) => void | Promise<void>;
  onSecretDelete?: (
    secret: SecretDeletePayload,
    from: string,
  ) => void | Promise<void>;
  onVaultKeyShare?: (keyHex: string, from: string) => void | Promise<void>;
  onStatus: (status: string) => void;
  onLog: (line: string) => void;
};

export class MobileSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  peer: PeerPublicKeys | null = null;
  private handlers: SessionHandlers;
  /** One connection per paired host (PC + laptop). */
  private conns = new Map<string, PeerConn>();
  private activePeerId: string | null = null;
  /** One-off socket for pairing handshakes (not tied to a stored peer). */
  private pairingSocket: WebSocket | null = null;
  private pairingTransport: TransportConfig | null = null;
  private pairingMode = false;
  private identityMeta: { name: string; type: DeviceType };
  private assemblers = new Map<string, ChunkAssembler>();

  constructor(stored: StoredDeviceKeys, handlers: SessionHandlers) {
    this.local = toDeviceKeys(stored);
    this.handlers = handlers;
    this.identityMeta = { name: stored.name, type: "android" };
  }

  /** Replace the paired set, keeping sockets for peers that are still paired. */
  setPeers(
    peers: StoredPeer[],
    transportFor: (peer: StoredPeer) => TransportConfig,
  ): void {
    const next = new Map<string, PeerConn>();
    for (const p of peers) {
      const existing = this.conns.get(p.deviceId);
      const keys: PeerPublicKeys = {
        deviceId: p.deviceId,
        ed25519PublicKey: p.ed25519PublicKey,
        x25519PublicKey: p.x25519PublicKey,
      };
      if (existing) {
        existing.peer = p;
        existing.keys = keys;
        existing.transport = transportFor(p);
        next.set(p.deviceId, existing);
      } else {
        next.set(p.deviceId, {
          peer: p,
          keys,
          transport: transportFor(p),
          ws: null,
          reconnectAttempts: 0,
          reconnectTimer: null,
        });
      }
    }
    // Sockets for peers that are no longer paired go away.
    for (const [id, conn] of this.conns) {
      if (!next.has(id)) this.teardownConn(conn);
    }
    this.conns = next;
    if (this.activePeerId && !next.has(this.activePeerId)) {
      this.activePeerId = null;
    }
    this.syncActivePeer();
  }

  setActivePeer(deviceId: string | null): void {
    if (deviceId && !this.conns.has(deviceId)) return;
    this.activePeerId = deviceId;
    this.syncActivePeer();
  }

  get activeDeviceId(): string | null {
    return this.activePeerId;
  }

  get peerIds(): string[] {
    return [...this.conns.keys()];
  }

  private syncActivePeer(): void {
    const id = this.activePeerId ?? this.conns.keys().next().value ?? null;
    const conn = id ? this.conns.get(id) : undefined;
    this.peer = conn?.keys ?? null;
  }

  private teardownConn(conn: PeerConn): void {
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    if (conn.ws) {
      conn.ws.onclose = null;
      conn.ws.onerror = null;
      conn.ws.onmessage = null;
      conn.ws.onopen = null;
      conn.ws.close();
      conn.ws = null;
    }
  }

  /** Open (or re-open) the socket for one paired host. */
  connectPeer(deviceId: string): void {
    const conn = this.conns.get(deviceId);
    if (conn) this.openConn(conn);
  }

  /** Open every paired host's socket — the "Connect" action. */
  connectAll(): void {
    for (const conn of this.conns.values()) this.openConn(conn);
  }

  setPeer(peer: StoredPeer): void {
    this.conns.set(peer.deviceId, {
      peer,
      keys: {
        deviceId: peer.deviceId,
        ed25519PublicKey: peer.ed25519PublicKey,
        x25519PublicKey: peer.x25519PublicKey,
      },
      transport: {
        mode: "lan",
        host: peer.host ?? "",
        port: peer.port ?? DEFAULT_PORT,
        relayUrl: "",
      },
      ws: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });
    this.setActivePeer(peer.deviceId);
  }

  /** Pairing transport: a one-off socket used to exchange handshakes. */
  connect(transport: TransportConfig, opts?: { pairing?: boolean }): void {
    this.pairingTransport = transport;
    this.pairingMode = opts?.pairing === true;
    this.teardownPairingSocket();
    this.openPairingSocket(transport);
  }

  clearPeer(): void {
    for (const conn of this.conns.values()) this.teardownConn(conn);
    this.conns.clear();
    this.activePeerId = null;
    this.peer = null;
    this.teardownPairingSocket();
  }

  get isOpen(): boolean {
    return this.activeConn()?.ws?.readyState === WebSocket.OPEN;
  }

  /** Is any paired host connected? */
  get anyOpen(): boolean {
    for (const conn of this.conns.values()) {
      if (conn.ws?.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  isPeerOpen(deviceId: string): boolean {
    return this.conns.get(deviceId)?.ws?.readyState === WebSocket.OPEN;
  }

  private activeConn(): PeerConn | undefined {
    const id = this.activePeerId ?? this.conns.keys().next().value;
    return id ? this.conns.get(id) : undefined;
  }

  /** Open one paired host's socket (idempotent). */
  private openConn(conn: PeerConn): void {
    if (conn.ws && conn.ws.readyState <= WebSocket.OPEN) return;
    let url: string;
    try {
      url = resolveWsUrl(
        conn.transport,
        this.local.deviceId,
        conn.peer.deviceId,
      );
    } catch (e) {
      this.handlers.onLog(`${conn.peer.name}: ${String(e)}`);
      return;
    }

    this.handlers.onLog(`${conn.peer.name}: connecting ${url}`);
    const ws = new WebSocket(url);
    conn.ws = ws;

    ws.onopen = () => {
      conn.reconnectAttempts = 0;
      this.handlers.onStatus(
        `connected (${conn.transport.mode}) · ${conn.peer.name}`,
      );
      // Identify this socket straight away, so the desktop can route replies
      // to the selected device instead of whichever connected last.
      try {
        this.sendFrameTo(
          conn.peer.deviceId,
          createMessageBody(
            this.local.deviceId,
            { type: "ping", ts: Date.now() },
            conn.peer.deviceId,
          ),
        );
      } catch {
        /* socket raced closed */
      }
    };
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      void this.handleIncomingRaw(raw, conn.peer.deviceId);
    };
    ws.onerror = () => {
      this.handlers.onLog(`${conn.peer.name}: socket error`);
    };
    ws.onclose = () => {
      conn.ws = null;
      this.handlers.onStatus(`disconnected · ${conn.peer.name}`);
      this.scheduleReconnect(conn);
    };
  }

  /**
   * Reconnect with backoff: a flat 2.5s retry hammers a sleeping PC, drains
   * battery, and gets the phone's socket rate-limited on mobile networks.
   * 2.5s → 5s → 10s … capped at 60s, reset on a successful open.
   */
  private scheduleReconnect(conn: PeerConn): void {
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    const attempt = conn.reconnectAttempts;
    conn.reconnectAttempts = Math.min(attempt + 1, RECONNECT_MAX_ATTEMPTS);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const label =
      delay >= 1000 ? `${(delay / 1000).toFixed(0)}s` : `${delay}ms`;
    this.handlers.onLog(
      `${conn.peer.name}: reconnect in ${label} (attempt ${attempt + 1})`,
    );
    conn.reconnectTimer = setTimeout(() => this.openConn(conn), delay);
  }

  /** One-off pairing socket (not bound to a stored peer). */
  private openPairingSocket(transport: TransportConfig): void {
    let url: string;
    try {
      url = resolveWsUrl(transport, this.local.deviceId, this.peer?.deviceId);
    } catch (e) {
      this.handlers.onStatus(`error: ${String(e)}`);
      return;
    }

    this.handlers.onStatus(`connecting ${url}`);
    const ws = new WebSocket(url);
    this.pairingSocket = ws;

    ws.onopen = () => {
      this.handlers.onStatus(
        this.pairingMode
          ? `connected (pairing)`
          : `connected (${transport.mode})`,
      );
      if (this.pairingMode) {
        const req = buildPairRequest(
          this.local,
          this.identityMeta.name,
          this.identityMeta.type,
        );
        ws.send(JSON.stringify(req));
        this.handlers.onLog("pair request sent");
      }
    };
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      void this.handleIncomingRaw(raw);
    };
    ws.onerror = () => {
      this.handlers.onStatus("socket error");
    };
    ws.onclose = () => {
      this.pairingSocket = null;
      this.handlers.onStatus("disconnected");
    };
  }

  private teardownPairingSocket(): void {
    if (this.pairingSocket) {
      this.pairingSocket.onclose = null;
      this.pairingSocket.close();
      this.pairingSocket = null;
    }
    this.pairingMode = false;
  }

  /** Close every socket, keep pairings. */
  disconnect(): void {
    for (const conn of this.conns.values()) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      if (conn.ws) {
        conn.ws.onclose = null;
        conn.ws.close();
        conn.ws = null;
      }
    }
    this.teardownPairingSocket();
  }

  async handleIncomingRaw(raw: string, fromPeerId?: string): Promise<void> {
    const handshake = parsePairHandshake(raw);
    if (handshake) {
      if (handshake.kind === "involvex-sync-pair-accept") {
        this.pairingMode = false;
        await this.handlers.onPairAccept?.(handshake);
        return;
      }
      if (handshake.kind === "involvex-sync-pair-reject") {
        this.pairingMode = false;
        await this.handlers.onPairReject?.(handshake.reason);
        this.teardownPairingSocket();
        return;
      }
      return;
    }

    if (this.conns.size === 0) {
      this.handlers.onLog("drop: no peer");
      return;
    }
    const frame = parseFrame(raw);
    if (!frame) {
      this.handlers.onLog("drop: bad frame");
      return;
    }
    // The envelope names the sender, so the right key is chosen by identity
    // rather than by whichever socket happened to deliver it.
    const conn =
      (fromPeerId ? this.conns.get(fromPeerId) : undefined) ??
      this.conns.get(frame.from);
    const peer = conn?.keys;
    if (!conn || !peer) {
      this.handlers.onLog(`drop: unknown sender ${frame.from}`);
      return;
    }
    const result = decryptFrame(frame, this.local, peer);
    if (!result.ok) {
      this.handlers.onLog(`drop: ${result.error}`);
      return;
    }
    if (result.body.to && result.body.to !== this.local.deviceId) {
      this.handlers.onLog(
        `drop: addressed to ${result.body.to}, not ${this.local.deviceId}`,
      );
      return;
    }
    await this.dispatch(result.body);
  }

  private async dispatch(body: MessageBody): Promise<void> {
    const { payload } = body;
    switch (payload.type) {
      case "share_url": {
        const url = parseAllowedUrl(payload.url);
        if (!url) return;
        await this.handlers.onShareUrl(url, body.from);
        break;
      }
      case "termux_open_url": {
        const url = parseAllowedUrl(payload.url);
        if (!url) return;
        if (this.handlers.onTermuxOpenUrl) {
          await this.handlers.onTermuxOpenUrl(url, body.from);
        } else {
          await this.handlers.onShareUrl(url, body.from);
        }
        break;
      }
      case "clipboard_update": {
        this.loop.remember(payload.text, body.from);
        await this.handlers.onClipboard(payload.text, body.from);
        break;
      }
      case "termux_clipboard_set": {
        this.loop.remember(payload.text, body.from);
        if (this.handlers.onTermuxClipboardSet) {
          await this.handlers.onTermuxClipboardSet(payload.text, body.from);
        } else {
          await this.handlers.onClipboard(payload.text, body.from);
        }
        break;
      }
      case "file_transfer": {
        if (payload.purpose === "clipboard") {
          const hash =
            payload.hash ?? hashBytes(fromBase64(payload.dataBase64));
          this.loop.rememberHash(hash, body.from);
          await this.handlers.onClipboardImage?.(
            {
              name: payload.name,
              mimeType: payload.mimeType,
              dataBase64: payload.dataBase64,
              size: payload.size,
              hash,
            },
            body.from,
          );
          break;
        }
        await this.handlers.onFileTransfer?.(
          {
            name: payload.name,
            mimeType: payload.mimeType,
            dataBase64: payload.dataBase64,
            size: payload.size,
          },
          body.from,
        );
        break;
      }
      case "file_offer": {
        try {
          this.assemblers.set(payload.transferId, new ChunkAssembler(payload));
          this.handlers.onLog(
            `file offer ${payload.name} (${payload.size} B, ${payload.totalChunks} chunks${payload.purpose === "clipboard" ? ", clipboard" : ""})`,
          );
        } catch (e) {
          this.handlers.onLog(`file offer rejected: ${String(e)}`);
        }
        break;
      }
      case "file_chunk": {
        const asm = this.assemblers.get(payload.transferId);
        if (!asm) {
          this.handlers.onLog("drop: unknown transfer chunk");
          break;
        }
        try {
          asm.addChunk(payload.index, payload.dataBase64);
          if (payload.index % 8 === 0 || asm.isComplete()) {
            this.handlers.onLog(
              `file ${asm.name} ${Math.round(asm.progress * 100)}%`,
            );
          }
        } catch (e) {
          this.handlers.onLog(`chunk error: ${String(e)}`);
        }
        break;
      }
      case "file_done": {
        const asm = this.assemblers.get(payload.transferId);
        this.assemblers.delete(payload.transferId);
        if (!asm) break;
        try {
          const data = asm.finish(payload.sha256);
          if (asm.purpose === "clipboard") {
            this.loop.rememberHash(payload.sha256, body.from);
            await this.handlers.onClipboardImage?.(
              {
                name: asm.name,
                mimeType: asm.mimeType,
                dataBase64: toBase64(data),
                size: asm.size,
                hash: payload.sha256,
              },
              body.from,
            );
            this.handlers.onLog(`clipboard image complete ${asm.name}`);
            break;
          }
          await this.handlers.onFileTransfer?.(
            {
              name: asm.name,
              mimeType: asm.mimeType,
              dataBase64: toBase64(data),
              size: asm.size,
            },
            body.from,
          );
          this.handlers.onLog(`file complete ${asm.name}`);
        } catch (e) {
          this.handlers.onLog(`file done failed: ${String(e)}`);
        }
        break;
      }
      case "file_abort": {
        this.assemblers.delete(payload.transferId);
        this.handlers.onLog(
          `file abort ${payload.transferId}${payload.reason ? `: ${payload.reason}` : ""}`,
        );
        break;
      }
      case "keyboard_text": {
        await this.handlers.onKeyboardText?.(payload.text);
        break;
      }
      case "keyboard_key": {
        await this.handlers.onKeyboardKey?.(payload.key);
        break;
      }
      case "find_phone": {
        await this.handlers.onFindPhone?.(payload.durationMs);
        break;
      }
      case "remote_command": {
        await this.handlers.onRemoteCommand?.(
          {
            requestId: payload.requestId,
            shell: payload.shell,
            command: payload.command,
            timeoutMs: payload.timeoutMs,
          },
          body.from,
        );
        break;
      }
      case "remote_command_result": {
        await this.handlers.onRemoteCommandResult?.(
          {
            requestId: payload.requestId,
            ok: payload.ok,
            exitCode: payload.exitCode,
            stdout: payload.stdout,
            stderr: payload.stderr,
          },
          body.from,
        );
        break;
      }
      case "note_upsert":
        await this.handlers.onNoteUpsert?.(payload, body.from);
        break;
      case "note_delete":
        await this.handlers.onNoteDelete?.(payload, body.from);
        break;
      case "secret_upsert":
        await this.handlers.onSecretUpsert?.(payload, body.from);
        break;
      case "secret_delete":
        await this.handlers.onSecretDelete?.(payload, body.from);
        break;
      case "vault_key_share":
        await this.handlers.onVaultKeyShare?.(payload.keyHex, body.from);
        break;
      default:
        this.handlers.onLog(`recv unknown payload`);
    }
  }

  /** Send to the active host only. */
  private sendFrame(body: MessageBody): void {
    const conn = this.activeConn();
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const frame = encryptFrame(body, this.local, conn.keys);
    conn.ws.send(serializeFrame(frame));
  }

  /** Send to one specific host (no-op when it is offline). */
  private sendFrameTo(deviceId: string, body: MessageBody): boolean {
    const conn = this.conns.get(deviceId);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const frame = encryptFrame(body, this.local, conn.keys);
    conn.ws.send(serializeFrame(frame));
    return true;
  }

  /** Send a body to every connected host. Returns how many received it. */
  private broadcastFrame(body: MessageBody): number {
    let sent = 0;
    for (const conn of this.conns.values()) {
      if (conn.ws?.readyState === WebSocket.OPEN) {
        const frame = encryptFrame(body, this.local, conn.keys);
        conn.ws.send(serializeFrame(frame));
        sent += 1;
      }
    }
    if (sent === 0) throw new Error("not connected");
    return sent;
  }

  sendShareUrl(urlInput: string): void {
    const body = shareUrlBody(
      this.local.deviceId,
      urlInput,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("url not allowed");
    this.sendFrame(body);
  }

  sendClipboard(text: string): void {
    if (!this.peer) throw new Error("not connected");
    if (this.loop.shouldSkipOutbound(text, this.local.deviceId)) {
      this.handlers.onLog("skip clipboard echo");
      return;
    }
    this.sendFrame(
      clipboardUpdateBody(this.local.deviceId, text, this.peer.deviceId),
    );
  }

  sendClipboardImage(file: {
    name: string;
    mimeType: string;
    data?: Uint8Array;
    dataBase64?: string;
  }): void {
    if (!this.peer) throw new Error("not connected");
    const data =
      file.data ?? (file.dataBase64 ? fromBase64(file.dataBase64) : null);
    if (!data) throw new Error("missing image bytes");
    assertClipboardImageSize(data.byteLength);
    const hash = hashBytes(data);
    if (this.loop.shouldSkipOutboundHash(hash, this.local.deviceId)) {
      this.handlers.onLog("skip clipboard image echo");
      return;
    }
    this.sendFile({
      name: file.name,
      mimeType: file.mimeType,
      data,
      purpose: "clipboard",
      hash,
    });
  }

  sendFile(file: {
    name: string;
    mimeType: string;
    data?: Uint8Array;
    dataBase64?: string;
    size?: number;
    purpose?: "file" | "clipboard";
    hash?: string;
  }): void {
    if (!this.peer) throw new Error("not connected");
    const data =
      file.data ?? (file.dataBase64 ? fromBase64(file.dataBase64) : null);
    if (!data) throw new Error("missing file bytes");
    const purpose = file.purpose === "clipboard" ? "clipboard" : "file";
    if (purpose === "clipboard") {
      assertClipboardImageSize(data.byteLength);
    } else {
      assertSendableSize(data.byteLength);
    }
    const hash =
      file.hash ?? (purpose === "clipboard" ? hashBytes(data) : undefined);
    if (data.byteLength <= FILE_CHUNK_BYTES) {
      this.sendFrame(
        fileTransferBody(
          this.local.deviceId,
          {
            name: file.name,
            mimeType: file.mimeType,
            dataBase64: toBase64(data),
            size: data.byteLength,
            purpose: purpose === "clipboard" ? "clipboard" : undefined,
            hash,
          },
          this.peer.deviceId,
        ),
      );
      this.handlers.onLog(
        `sent ${purpose === "clipboard" ? "clipboard image" : "file"} ${file.name} (${data.byteLength} B)`,
      );
      return;
    }
    const transferId = bytesToHex(randomBytes(8));
    const totalChunks = chunkCountForSize(data.byteLength);
    this.sendFrame(
      fileOfferBody(
        this.local.deviceId,
        {
          transferId,
          name: file.name,
          mimeType: file.mimeType,
          size: data.byteLength,
          totalChunks,
          purpose: purpose === "clipboard" ? "clipboard" : undefined,
          hash,
        },
        this.peer.deviceId,
      ),
    );
    const iter = iterateFileChunks(data);
    let step = iter.next();
    while (!step.done) {
      this.sendFrame(
        fileChunkBody(
          this.local.deviceId,
          {
            transferId,
            index: step.value.index,
            dataBase64: step.value.dataBase64,
          },
          this.peer.deviceId,
        ),
      );
      step = iter.next();
    }
    this.sendFrame(
      fileDoneBody(
        this.local.deviceId,
        { transferId, sha256: step.value },
        this.peer.deviceId,
      ),
    );
    this.handlers.onLog(
      `sent ${purpose === "clipboard" ? "clipboard image" : "file"} ${file.name} (${data.byteLength} B, ${totalChunks} chunks)`,
    );
  }

  /** Mirrored notifications are interesting to every host. */
  sendNotificationMirror(note: {
    title: string;
    body: string;
    packageName?: string;
    when?: number;
  }): void {
    this.broadcastFrame(notificationMirrorBody(this.local.deviceId, note));
  }

  /** Keyboard status must reach every host so each can unlock its tab. */
  sendKeyboardStatus(active: boolean, mode?: "ime" | "a11y" | "none"): void {
    if (!this.anyOpen) return;
    try {
      this.broadcastFrame(
        keyboardStatusBody(this.local.deviceId, active, undefined, mode),
      );
    } catch {
      /* ignore */
    }
  }

  sendRemoteCommand(cmd: {
    requestId: string;
    shell: RemoteShell;
    command: string;
    timeoutMs?: number;
  }): void {
    const body = remoteCommandBody(
      this.local.deviceId,
      cmd,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid remote command");
    this.sendFrame(body);
  }

  sendRemoteCommandResult(result: RemoteCommandResult): void {
    const body = remoteCommandResultBody(
      this.local.deviceId,
      result,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid remote result");
    this.sendFrame(body);
  }

  abortTransfer(transferId: string, reason?: string): void {
    if (!this.peer) return;
    this.assemblers.delete(transferId);
    try {
      this.sendFrame(
        fileAbortBody(
          this.local.deviceId,
          { transferId, reason },
          this.peer.deviceId,
        ),
      );
    } catch {
      /* ignore */
    }
  }

  /** Notes are shared state: every host gets its own encrypted copy. */
  sendNoteUpsert(note: {
    id: string;
    title: string;
    body: string;
    updatedAt: number;
  }): void {
    if (!noteUpsertBody(this.local.deviceId, note)) {
      throw new Error("invalid note");
    }
    for (const id of this.conns.keys()) {
      this.sendFrameTo(
        id,
        noteUpsertBody(this.local.deviceId, note, id) as MessageBody,
      );
    }
  }

  sendNoteDelete(note: { id: string; updatedAt: number }): void {
    if (!noteDeleteBody(this.local.deviceId, note)) {
      throw new Error("invalid note delete");
    }
    for (const id of this.conns.keys()) {
      this.sendFrameTo(
        id,
        noteDeleteBody(this.local.deviceId, note, id) as MessageBody,
      );
    }
  }

  sendSecretUpsert(secret: {
    id: string;
    updatedAt: number;
    ciphertext: string;
    nonce: string;
    meta: SecretUpsertPayload["meta"];
  }): void {
    if (!secretUpsertBody(this.local.deviceId, secret)) {
      throw new Error("invalid secret");
    }
    for (const id of this.conns.keys()) {
      this.sendFrameTo(
        id,
        secretUpsertBody(this.local.deviceId, secret, id) as MessageBody,
      );
    }
  }

  sendSecretDelete(secret: { id: string; updatedAt: number }): void {
    if (!secretDeleteBody(this.local.deviceId, secret)) {
      throw new Error("invalid secret delete");
    }
    for (const id of this.conns.keys()) {
      this.sendFrameTo(
        id,
        secretDeleteBody(this.local.deviceId, secret, id) as MessageBody,
      );
    }
  }

  /** The vault key is the root of the shared secret store — all hosts need it. */
  sendVaultKeyShare(keyHex: string): void {
    if (!vaultKeyShareBody(this.local.deviceId, keyHex)) {
      throw new Error("invalid vault key");
    }
    let sent = 0;
    for (const id of this.conns.keys()) {
      const body = vaultKeyShareBody(this.local.deviceId, keyHex, id);
      if (body && this.sendFrameTo(id, body)) sent += 1;
    }
    if (sent === 0) this.handlers.onLog("vault key share: no host connected");
  }
}
