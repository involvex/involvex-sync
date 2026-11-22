import {
  type DeviceKeys,
  type DeviceType,
  type KeyboardKeyId,
  LoopGuard,
  type MessageBody,
  type NoteDeletePayload,
  type NoteUpsertPayload,
  type PairRequestPayload,
  type PeerPublicKeys,
  type RemoteShell,
  type SecretDeletePayload,
  type SecretUpsertPayload,
  FILE_CHUNK_BYTES,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_FILE_TRANSFER_BYTES,
  ChunkAssembler,
  assertClipboardImageSize,
  assertSendableSize,
  buildPairAccept,
  buildPairReject,
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
  findPhoneBody,
  fromBase64,
  hashBytes,
  iterateFileChunks,
  keyboardKeyBody,
  keyboardTextBody,
  noteDeleteBody,
  noteUpsertBody,
  parseAllowedUrl,
  parseFrame,
  parsePairHandshake,
  randomBytes,
  adbScreencapRequestBody,
  remoteCommandBody,
  remoteCommandResultBody,
  secretDeleteBody,
  secretUpsertBody,
  serializeFrame,
  shareUrlBody,
  toBase64,
  vaultKeyShareBody,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import {
  type StoredDeviceKeys,
  type StoredPeer,
  toDeviceKeys,
} from "./identity";

/** Cap concurrent inbound chunked receives so stalled transfers cannot pin RAM. */
const MAX_ASSEMBLERS = 3;
const ASSEMBLER_IDLE_TTL_MS = 90_000;

type AssemblerEntry = {
  assembler: ChunkAssembler;
  lastActivity: number;
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
  onFileTransfer?: (
    file: {
      name: string;
      mimeType: string;
      dataBase64: string;
      size: number;
      relativePath?: string;
    },
    from: string,
  ) => void | Promise<void>;
  onNotificationMirror?: (
    note: {
      title: string;
      body: string;
      packageName?: string;
      when: number;
    },
    from: string,
  ) => void | Promise<void>;
  onKeyboardStatus?: (
    active: boolean,
    mode?: "ime" | "a11y" | "none",
  ) => void | Promise<void>;
  onPairRequest?: (request: PairRequestPayload) => void | Promise<void>;
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
  onRemoteCommand?: (
    request: RemoteCommandRequest,
    from: string,
  ) => void | Promise<void>;
  onRemoteCommandResult?: (
    result: RemoteCommandResult,
    from: string,
  ) => void | Promise<void>;
  onAdbScreencapRequest?: (
    requestId: string,
    from: string,
  ) => void | Promise<void>;
  /**
   * Fired once when a paired device's socket is newly mapped (or remapped to a
   * different conn id). Used to replay notes/secrets/vault catch-up.
   */
  onPeerOnline?: (deviceId: string) => void | Promise<void>;
  /** Inbound or outbound chunked transfer progress (0–100). */
  onTransferProgress?: (info: {
    transferId: string;
    name: string;
    percent: number;
    direction: "in" | "out";
  }) => void;
  onTransferComplete?: (info: {
    transferId: string;
    name: string;
    direction: "in" | "out";
  }) => void;
  onTransferFailed?: (info: {
    transferId: string;
    name?: string;
    reason: string;
    direction: "in" | "out";
  }) => void;
  /** Worker / relay rejected a frame (e.g. too large). */
  onRelayError?: (error: string) => void;
  onLog: (line: string) => void;
};

export class SyncSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  /** Active peer — clipboard/files/find/keyboard/commands target this device. */
  peer: PeerPublicKeys | null = null;
  private handlers: SessionHandlers;
  private identityMeta: { name: string; type: DeviceType };
  /** Every paired device, keyed by device id. */
  private peerMap = new Map<string, PeerPublicKeys>();
  private activePeerId: string | null = null;
  /**
   * deviceId → local socket id. The WS hub addresses sockets, the session
   * addresses devices, so outbound frames need this translation; without it
   * `ws_send` would always hit the most recently connected socket instead of
   * the device the user selected.
   */
  private connByDevice = new Map<string, number>();
  /**
   * Pair requests waiting for a decision, each tagged with the socket it
   * arrived on: the accept/reject must go back the same way.
   */
  private pendingPairs: Array<{
    request: PairRequestPayload;
    connId?: number;
  }> = [];
  /** Per-peer relay senders (one Cloudflare room each). */
  private relaySendByPeer = new Map<string, (raw: string) => void>();
  /**
   * Legacy single-room fallback used by tests / older callers: any peerId
   * routes through this function when no per-peer sender is registered.
   */
  private relaySendAny: ((raw: string) => void) | null = null;
  private assemblers = new Map<string, AssemblerEntry>();
  /** Outbound chunked transfers the UI may cancel mid-send. */
  private outboundAbort = new Set<string>();
  private outboundNames = new Map<string, string>();

  constructor(stored: StoredDeviceKeys, handlers: SessionHandlers) {
    this.local = toDeviceKeys(stored);
    this.handlers = handlers;
    this.identityMeta = { name: stored.name, type: "windows" };
  }

  /** Replace the whole paired set; keeps the active peer when possible. */
  setPeers(peers: StoredPeer[]): void {
    this.peerMap = new Map(
      peers.map((p) => [
        p.deviceId,
        {
          deviceId: p.deviceId,
          ed25519PublicKey: p.ed25519PublicKey,
          x25519PublicKey: p.x25519PublicKey,
        },
      ]),
    );
    if (this.activePeerId && this.peerMap.has(this.activePeerId)) {
      this.peer = this.peerMap.get(this.activePeerId) ?? null;
      this.pruneConns();
      return;
    }
    const first = this.peerMap.keys().next();
    this.activePeerId = first.done ? null : first.value;
    this.peer = this.activePeerId
      ? (this.peerMap.get(this.activePeerId) ?? null)
      : null;
    this.pruneConns();
  }

  /** Drop socket mappings for devices that are no longer paired. */
  private pruneConns(): void {
    for (const deviceId of this.connByDevice.keys()) {
      if (!this.peerMap.has(deviceId)) this.connByDevice.delete(deviceId);
    }
  }

  /** Upsert one pairing. `active` makes it the send target. */
  addPeer(peer: StoredPeer, active = false): void {
    this.peerMap.set(peer.deviceId, {
      deviceId: peer.deviceId,
      ed25519PublicKey: peer.ed25519PublicKey,
      x25519PublicKey: peer.x25519PublicKey,
    });
    if (active) this.setActivePeer(peer.deviceId);
  }

  setActivePeer(deviceId: string | null): void {
    if (deviceId && !this.peerMap.has(deviceId)) return;
    this.activePeerId = deviceId;
    this.peer = deviceId ? (this.peerMap.get(deviceId) ?? null) : null;
  }

  get activeDeviceId(): string | null {
    return this.activePeerId;
  }

  get peerIds(): string[] {
    return [...this.peerMap.keys()];
  }

  removePeer(deviceId: string): void {
    this.peerMap.delete(deviceId);
    this.connByDevice.delete(deviceId);
    if (this.activePeerId === deviceId) {
      const next = this.peerMap.keys().next();
      this.activePeerId = next.done ? null : next.value;
      this.peer = this.activePeerId
        ? (this.peerMap.get(this.activePeerId) ?? null)
        : null;
    }
  }

  setPeer(peer: StoredPeer): void {
    this.addPeer(peer, true);
  }

  clearPeer(): void {
    this.peerMap.clear();
    this.connByDevice.clear();
    this.activePeerId = null;
    this.peer = null;
    this.pendingPairs = [];
  }

  /** Socket id a device was last heard on, for targeted sends / cleanup. */
  connIdFor(deviceId: string): number | undefined {
    return this.connByDevice.get(deviceId);
  }

  /** Forget every mapping that pointed at a socket the hub just dropped. */
  forgetConn(connId: number): void {
    for (const [deviceId, id] of this.connByDevice) {
      if (id === connId) this.connByDevice.delete(deviceId);
    }
  }

  /**
   * Relay fallback used when the LAN socket cannot carry the frame.
   * One sender covers every peer id (tests / single-room callers).
   */
  setRelaySender(send: ((raw: string) => void) | null): void {
    this.relaySendAny = send;
  }

  /**
   * One Cloudflare room per paired device. Preferred over {@link setRelaySender}.
   */
  setRelaySenders(
    senders: ReadonlyMap<string, (raw: string) => void> | null,
  ): void {
    this.relaySendByPeer = senders
      ? new Map<string, (raw: string) => void>(senders)
      : new Map<string, (raw: string) => void>();
  }

  /** Surface a worker `{ error }` so in-flight sends can fail visibly. */
  reportRelayError(error: string): void {
    this.handlers.onRelayError?.(error);
    this.handlers.onLog(`relay: ${error}`);
  }

  async handleIncomingRaw(raw: string, connId?: number): Promise<void> {
    // Relay control messages are not sealed frames.
    try {
      const parsed = JSON.parse(raw) as { error?: string; ok?: string };
      if (
        typeof parsed.error === "string" &&
        Object.keys(parsed).length === 1
      ) {
        this.reportRelayError(parsed.error);
        return;
      }
      if (parsed.ok === "hello") return;
    } catch {
      /* sealed / pair JSON */
    }

    const handshake = parsePairHandshake(raw);
    if (handshake) {
      if (handshake.kind === "involvex-sync-pair-request") {
        const deviceId = handshake.device.deviceId;
        const existing = this.pendingPairs.find(
          (p) => p.request.device.deviceId === deviceId,
        );
        if (!existing) {
          this.pendingPairs.push({ request: handshake, connId });
        }
        if (connId !== undefined) {
          this.connByDevice.set(deviceId, connId);
        }
        await this.handlers.onPairRequest?.(handshake);
        return;
      }
      return;
    }

    if (!this.peer) {
      this.handlers.onLog("drop: no peer paired");
      return;
    }
    const frame = parseFrame(raw);
    if (!frame) {
      this.handlers.onLog("drop: invalid frame json");
      return;
    }
    // The outer envelope carries the sender in the clear, so with several
    // paired devices the right key is picked instead of guessing.
    const peer = this.peerMap.get(frame.from);
    if (!peer) {
      this.handlers.onLog(`drop: unknown sender ${frame.from}`);
      return;
    }
    const result = decryptFrame(frame, this.local, peer);
    if (!result.ok) {
      this.handlers.onLog(`drop: ${result.error}`);
      return;
    }
    // Remember which socket this device is on so replies go back to it.
    // A new or remapped conn id means the peer just became reachable.
    if (connId !== undefined) {
      const prev = this.connByDevice.get(frame.from);
      this.connByDevice.set(frame.from, connId);
      if (prev !== connId) {
        void this.handlers.onPeerOnline?.(frame.from);
      }
    }
    // Optional target field: reject frames aimed at another device of ours.
    if (result.body.to && result.body.to !== this.local.deviceId) {
      this.handlers.onLog(
        `drop: addressed to ${result.body.to}, not ${this.local.deviceId}`,
      );
      return;
    }
    await this.dispatch(result.body);
  }

  /**
   * LAN first, relay second. The relay owns the same encrypted frame, so no
   * payload is special-cased: clipboard, files, notes, keyboard, links and
   * commands all travel either way.
   */
  private async sendRaw(raw: string, connId?: number): Promise<void> {
    const peerId = this.peer?.deviceId;
    // Prefer the exact socket the active peer is on: `ws_send` alone would
    // deliver to the most recently connected device, not the selected one.
    const target =
      connId ?? (peerId ? this.connByDevice.get(peerId) : undefined);
    if (target !== undefined) {
      try {
        await invoke("ws_send_to", { connId: target, message: raw });
        return;
      } catch (e) {
        // The socket died (reconnect in progress) — forget it, use the relay.
        if (peerId) this.connByDevice.delete(peerId);
        if (!peerId) throw e instanceof Error ? e : new Error(String(e));
        return this.sendViaRelay(peerId, raw, e);
      }
    }

    // No mapping for the active peer. `ws_send` is only safe while a single
    // device is paired; with several it could reach the wrong socket, so go
    // straight to the relay, which is addressed per peer.
    if (this.peerMap.size > 1) {
      if (!peerId) {
        throw new Error(
          "active device socket unknown (several devices paired)",
        );
      }
      return this.sendViaRelay(
        peerId,
        raw,
        "active device socket unknown (several devices paired)",
      );
    }

    try {
      await invoke("ws_send", { message: raw });
      return;
    } catch (e) {
      if (!peerId) throw e instanceof Error ? e : new Error(String(e));
      return this.sendViaRelay(peerId, raw, e);
    }
  }

  private relaySenderFor(peerId: string): ((raw: string) => void) | null {
    return this.relaySendByPeer.get(peerId) ?? this.relaySendAny;
  }

  private sendViaRelay(
    peerId: string,
    raw: string,
    lanError: unknown,
  ): Promise<void> {
    const reason =
      lanError instanceof Error ? lanError : new Error(String(lanError));
    const send = this.relaySenderFor(peerId);
    if (!send) return Promise.reject(reason);
    this.handlers.onLog(
      `relay: LAN send failed (${String(lanError)}), using relay for ${peerId}`,
    );
    try {
      send(raw);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async acceptPair(
    request: PairRequestPayload,
    host?: string,
    port?: number,
  ): Promise<void> {
    const accept = buildPairAccept(
      this.local,
      this.identityMeta.name,
      this.identityMeta.type,
      host,
      port,
    );
    const pending = this.pendingPairs.find(
      (p) => p.request.device.deviceId === request.device.deviceId,
    );
    await this.sendRaw(JSON.stringify(accept), pending?.connId);
    this.pendingPairs = this.pendingPairs.filter(
      (p) => p.request.device.deviceId !== request.device.deviceId,
    );
  }

  async rejectPair(
    request: PairRequestPayload,
    reason?: string,
  ): Promise<void> {
    const pending = this.pendingPairs.find(
      (p) => p.request.device.deviceId === request.device.deviceId,
    );
    const deviceId = request.device.deviceId;
    const reject = buildPairReject(deviceId, reason);
    try {
      await this.sendRaw(JSON.stringify(reject), pending?.connId);
    } catch {
      /* peer may already be gone */
    }
    this.pendingPairs = this.pendingPairs.filter(
      (p) => p.request.device.deviceId !== request.device.deviceId,
    );
  }

  private async dispatch(body: MessageBody): Promise<void> {
    const { payload } = body;
    switch (payload.type) {
      case "share_url":
      case "termux_open_url": {
        const url = parseAllowedUrl(payload.url);
        if (!url) {
          this.handlers.onLog("drop: url not allowed");
          return;
        }
        await this.handlers.onShareUrl(url, body.from);
        break;
      }
      case "clipboard_update":
      case "termux_clipboard_set": {
        this.loop.remember(payload.text, body.from);
        await this.handlers.onClipboard(payload.text, body.from);
        break;
      }
      case "file_transfer": {
        const maxBytes =
          payload.purpose === "clipboard"
            ? MAX_CLIPBOARD_IMAGE_BYTES
            : MAX_FILE_TRANSFER_BYTES;
        if (typeof payload.size === "number" && payload.size > maxBytes) {
          this.handlers.onLog(
            `drop: file_transfer size ${payload.size} > ${maxBytes}`,
          );
          break;
        }
        // Base64 expands ~4/3; reject oversized wire payloads before decode.
        if (payload.dataBase64.length > Math.ceil((maxBytes * 4) / 3) + 64) {
          this.handlers.onLog("drop: file_transfer payload too large");
          break;
        }
        let decoded: Uint8Array;
        try {
          decoded = fromBase64(payload.dataBase64);
        } catch (e) {
          this.handlers.onLog(`drop: file_transfer base64: ${String(e)}`);
          break;
        }
        if (decoded.byteLength > maxBytes) {
          this.handlers.onLog(
            `drop: file_transfer decoded ${decoded.byteLength} > ${maxBytes}`,
          );
          break;
        }
        if (payload.purpose === "clipboard") {
          const hash = payload.hash ?? hashBytes(decoded);
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
            ...(payload.relativePath
              ? { relativePath: payload.relativePath }
              : {}),
          },
          body.from,
        );
        break;
      }
      case "file_offer": {
        try {
          this.reapIdleAssemblers();
          if (this.assemblers.has(payload.transferId)) {
            this.assemblers.delete(payload.transferId);
          }
          while (this.assemblers.size >= MAX_ASSEMBLERS) {
            const oldest = this.oldestAssemblerId();
            if (!oldest) break;
            this.handlers.onLog(
              `file offer drop oldest transfer ${oldest} (cap ${MAX_ASSEMBLERS})`,
            );
            this.assemblers.delete(oldest);
          }
          this.assemblers.set(payload.transferId, {
            assembler: new ChunkAssembler(payload),
            lastActivity: Date.now(),
          });
          this.handlers.onLog(
            `file offer ${payload.name} (${payload.size} B, ${payload.totalChunks} chunks${payload.purpose === "clipboard" ? ", clipboard" : ""})`,
          );
        } catch (e) {
          this.handlers.onLog(`file offer rejected: ${String(e)}`);
        }
        break;
      }
      case "file_chunk": {
        this.reapIdleAssemblers();
        const entry = this.assemblers.get(payload.transferId);
        if (!entry) {
          this.handlers.onLog("drop: unknown transfer chunk");
          break;
        }
        try {
          entry.assembler.addChunk(payload.index, payload.dataBase64);
          entry.lastActivity = Date.now();
          const percent = Math.round(entry.assembler.progress * 100);
          if (payload.index % 8 === 0 || entry.assembler.isComplete()) {
            this.handlers.onLog(`file ${entry.assembler.name} ${percent}%`);
          }
          this.handlers.onTransferProgress?.({
            transferId: payload.transferId,
            name: entry.assembler.name,
            percent,
            direction: "in",
          });
        } catch (e) {
          this.handlers.onLog(`chunk error: ${String(e)}`);
          this.handlers.onTransferFailed?.({
            transferId: payload.transferId,
            name: entry.assembler.name,
            reason: String(e),
            direction: "in",
          });
        }
        break;
      }
      case "file_done": {
        const entry = this.assemblers.get(payload.transferId);
        this.assemblers.delete(payload.transferId);
        if (!entry) break;
        const asm = entry.assembler;
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
            this.handlers.onTransferComplete?.({
              transferId: payload.transferId,
              name: asm.name,
              direction: "in",
            });
            break;
          }
          await this.handlers.onFileTransfer?.(
            {
              name: asm.name,
              mimeType: asm.mimeType,
              dataBase64: toBase64(data),
              size: asm.size,
              ...(asm.relativePath ? { relativePath: asm.relativePath } : {}),
            },
            body.from,
          );
          this.handlers.onLog(`file complete ${asm.name}`);
          this.handlers.onTransferComplete?.({
            transferId: payload.transferId,
            name: asm.name,
            direction: "in",
          });
        } catch (e) {
          this.handlers.onLog(`file done failed: ${String(e)}`);
          this.handlers.onTransferFailed?.({
            transferId: payload.transferId,
            name: asm.name,
            reason: String(e),
            direction: "in",
          });
        }
        break;
      }
      case "file_abort": {
        const entry = this.assemblers.get(payload.transferId);
        this.assemblers.delete(payload.transferId);
        this.handlers.onLog(
          `file abort ${payload.transferId}${payload.reason ? `: ${payload.reason}` : ""}`,
        );
        this.handlers.onTransferFailed?.({
          transferId: payload.transferId,
          name: entry?.assembler.name,
          reason: payload.reason ?? "aborted",
          direction: "in",
        });
        break;
      }
      case "notification_mirror": {
        await this.handlers.onNotificationMirror?.(
          {
            title: payload.title,
            body: payload.body,
            packageName: payload.packageName,
            when: payload.when,
          },
          body.from,
        );
        break;
      }
      case "keyboard_status": {
        await this.handlers.onKeyboardStatus?.(payload.active, payload.mode);
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
      case "adb_screencap_request": {
        await this.handlers.onAdbScreencapRequest?.(
          payload.requestId,
          body.from,
        );
        break;
      }
      case "ping":
      case "pong":
      case "pair_ack":
        this.handlers.onLog(`recv ${payload.type}`);
        break;
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
        this.handlers.onLog("drop: unknown payload");
    }
  }

  private async sendBody(body: MessageBody): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    const frame = encryptFrame(body, this.local, this.peer);
    await this.sendRaw(serializeFrame(frame));
  }

  /**
   * Seal + deliver one frame to a specific paired device. Prefers that
   * device's LAN socket; falls back to that peer's relay room when registered.
   */
  private async sendEncryptedTo(
    peerId: string,
    peer: PeerPublicKeys,
    body: MessageBody,
  ): Promise<void> {
    const raw = serializeFrame(encryptFrame(body, this.local, peer));
    const connId = this.connByDevice.get(peerId);
    if (connId !== undefined) {
      try {
        await invoke("ws_send_to", { connId, message: raw });
        return;
      } catch (e) {
        this.connByDevice.delete(peerId);
        return this.sendViaRelay(peerId, raw, e);
      }
    }
    return this.sendViaRelay(
      peerId,
      raw,
      `shared fan-out: ${peerId} socket unknown`,
    );
  }

  /**
   * Notes / secrets / vault key are shared state: every paired host that
   * is reachable gets its own sealed copy (matches mobile fan-out).
   */
  private async fanOutShared(
    build: (peerId: string) => MessageBody | null,
  ): Promise<void> {
    if (this.peerMap.size === 0) throw new Error("no peer paired");
    let sent = 0;
    let lastError: unknown;
    for (const [peerId, peer] of this.peerMap) {
      const body = build(peerId);
      if (!body) continue;
      try {
        await this.sendEncryptedTo(peerId, peer, body);
        sent += 1;
      } catch (e) {
        lastError = e;
        this.handlers.onLog(
          `fan-out skip ${peerId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (sent === 0) {
      throw lastError instanceof Error
        ? lastError
        : new Error("no host connected");
    }
  }

  async sendShareUrl(urlInput: string): Promise<void> {
    const body = shareUrlBody(
      this.local.deviceId,
      urlInput,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("url not allowed");
    await this.sendBody(body);
  }

  async sendClipboard(text: string): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    if (this.loop.shouldSkipOutbound(text, this.local.deviceId)) {
      this.handlers.onLog("skip clipboard echo");
      return;
    }
    await this.sendBody(
      clipboardUpdateBody(this.local.deviceId, text, this.peer.deviceId),
    );
  }

  async sendClipboardImage(file: {
    name: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    assertClipboardImageSize(file.data.byteLength);
    const hash = hashBytes(file.data);
    if (this.loop.shouldSkipOutboundHash(hash, this.local.deviceId)) {
      this.handlers.onLog("skip clipboard image echo");
      return;
    }
    await this.sendFile({
      ...file,
      purpose: "clipboard",
      hash,
    });
  }

  async sendFile(file: {
    name: string;
    mimeType: string;
    data: Uint8Array;
    purpose?: "file" | "clipboard";
    hash?: string;
    relativePath?: string;
  }): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    const purpose = file.purpose === "clipboard" ? "clipboard" : "file";
    if (purpose === "clipboard") {
      assertClipboardImageSize(file.data.byteLength);
    } else {
      assertSendableSize(file.data.byteLength);
    }
    const hash =
      file.hash ?? (purpose === "clipboard" ? hashBytes(file.data) : undefined);
    const relativePath =
      purpose === "clipboard" ? undefined : file.relativePath;
    if (file.data.byteLength <= FILE_CHUNK_BYTES) {
      await this.sendBody(
        fileTransferBody(
          this.local.deviceId,
          {
            name: file.name,
            mimeType: file.mimeType,
            dataBase64: toBase64(file.data),
            size: file.data.byteLength,
            purpose: purpose === "clipboard" ? "clipboard" : undefined,
            hash,
            relativePath,
          },
          this.peer.deviceId,
        ),
      );
      this.handlers.onLog(
        `sent ${purpose === "clipboard" ? "clipboard image" : "file"} ${file.name} (${file.data.byteLength} B)`,
      );
      return;
    }
    const transferId = bytesToHex(randomBytes(8));
    const totalChunks = chunkCountForSize(file.data.byteLength);
    this.outboundAbort.delete(transferId);
    this.outboundNames.set(transferId, file.name);
    try {
      await this.sendBody(
        fileOfferBody(
          this.local.deviceId,
          {
            transferId,
            name: file.name,
            mimeType: file.mimeType,
            size: file.data.byteLength,
            totalChunks,
            purpose: purpose === "clipboard" ? "clipboard" : undefined,
            hash,
            relativePath,
          },
          this.peer.deviceId,
        ),
      );
      const iter = iterateFileChunks(file.data);
      let step = iter.next();
      let sent = 0;
      while (!step.done) {
        if (this.outboundAbort.has(transferId)) {
          this.outboundAbort.delete(transferId);
          await this.sendBody(
            fileAbortBody(
              this.local.deviceId,
              { transferId, reason: "cancelled" },
              this.peer.deviceId,
            ),
          );
          this.handlers.onTransferFailed?.({
            transferId,
            name: file.name,
            reason: "cancelled",
            direction: "out",
          });
          throw new Error("transfer cancelled");
        }
        await this.sendBody(
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
        sent += 1;
        const percent = Math.round((sent / totalChunks) * 100);
        if (sent % 8 === 0 || sent === totalChunks) {
          this.handlers.onLog(`file ${file.name} ${percent}%`);
        }
        this.handlers.onTransferProgress?.({
          transferId,
          name: file.name,
          percent,
          direction: "out",
        });
        // Let the WebView GC between bursts so multi‑MB sends don't OOM.
        if (sent % 4 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        step = iter.next();
      }
      await this.sendBody(
        fileDoneBody(
          this.local.deviceId,
          { transferId, sha256: step.value },
          this.peer.deviceId,
        ),
      );
      this.handlers.onLog(
        `sent ${purpose === "clipboard" ? "clipboard image" : "file"} ${file.name} (${file.data.byteLength} B, ${totalChunks} chunks)`,
      );
      this.handlers.onTransferComplete?.({
        transferId,
        name: file.name,
        direction: "out",
      });
    } catch (e) {
      if (!(e instanceof Error && e.message === "transfer cancelled")) {
        this.handlers.onTransferFailed?.({
          transferId,
          name: file.name,
          reason: e instanceof Error ? e.message : String(e),
          direction: "out",
        });
      }
      throw e;
    } finally {
      this.outboundNames.delete(transferId);
      this.outboundAbort.delete(transferId);
    }
  }

  async sendKeyboardText(text: string): Promise<void> {
    const body = keyboardTextBody(
      this.local.deviceId,
      text,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("empty text");
    await this.sendBody(body);
  }

  async sendKeyboardKey(key: KeyboardKeyId): Promise<void> {
    const body = keyboardKeyBody(this.local.deviceId, key, this.peer?.deviceId);
    if (!body) throw new Error("bad key");
    await this.sendBody(body);
  }

  async sendFindPhone(durationMs = 30_000): Promise<void> {
    await this.sendBody(
      findPhoneBody(this.local.deviceId, durationMs, this.peer?.deviceId),
    );
  }

  async sendAdbScreencapRequest(requestId?: string): Promise<void> {
    const id = requestId?.trim() || bytesToHex(randomBytes(8));
    const body = adbScreencapRequestBody(
      this.local.deviceId,
      id,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid screencap request");
    await this.sendBody(body);
  }

  async sendRemoteCommand(cmd: {
    requestId: string;
    shell: RemoteShell;
    command: string;
    timeoutMs?: number;
  }): Promise<void> {
    const body = remoteCommandBody(
      this.local.deviceId,
      cmd,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid remote command");
    await this.sendBody(body);
  }

  async sendRemoteCommandResult(result: RemoteCommandResult): Promise<void> {
    const body = remoteCommandResultBody(
      this.local.deviceId,
      result,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid remote result");
    await this.sendBody(body);
  }

  abortTransfer(transferId: string, reason?: string): void {
    this.assemblers.delete(transferId);
    if (this.outboundNames.has(transferId)) {
      this.outboundAbort.add(transferId);
      return;
    }
    if (!this.peer) return;
    void this.sendBody(
      fileAbortBody(
        this.local.deviceId,
        { transferId, reason },
        this.peer.deviceId,
      ),
    );
    this.handlers.onTransferFailed?.({
      transferId,
      reason: reason ?? "aborted",
      direction: "in",
    });
  }

  /** Active inbound assemblers (for UI cancel buttons). */
  inboundTransfers(): Array<{
    transferId: string;
    name: string;
    percent: number;
  }> {
    const out: Array<{ transferId: string; name: string; percent: number }> =
      [];
    for (const [transferId, entry] of this.assemblers) {
      out.push({
        transferId,
        name: entry.assembler.name,
        percent: Math.round(entry.assembler.progress * 100),
      });
    }
    return out;
  }

  /** Exposed for tests — how many chunked receives are in flight. */
  assemblerCount(): number {
    return this.assemblers.size;
  }

  private oldestAssemblerId(): string | undefined {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.assemblers) {
      if (entry.lastActivity < oldestAt) {
        oldestAt = entry.lastActivity;
        oldestId = id;
      }
    }
    return oldestId;
  }

  private reapIdleAssemblers(now = Date.now()): void {
    for (const [id, entry] of this.assemblers) {
      if (now - entry.lastActivity > ASSEMBLER_IDLE_TTL_MS) {
        this.assemblers.delete(id);
        this.handlers.onLog(
          `file transfer ${id} timed out after ${ASSEMBLER_IDLE_TTL_MS / 1000}s idle`,
        );
      }
    }
  }

  async sendNoteUpsert(note: {
    id: string;
    title: string;
    body: string;
    updatedAt: number;
  }): Promise<void> {
    if (!noteUpsertBody(this.local.deviceId, note)) {
      throw new Error("invalid note");
    }
    await this.fanOutShared((peerId) =>
      noteUpsertBody(this.local.deviceId, note, peerId),
    );
  }

  /** Deliver one note upsert to a single paired peer (catch-up). */
  async sendNoteUpsertTo(
    peerId: string,
    note: {
      id: string;
      title: string;
      body: string;
      updatedAt: number;
    },
  ): Promise<void> {
    const peer = this.peerMap.get(peerId);
    if (!peer) throw new Error(`host ${peerId} not paired`);
    const body = noteUpsertBody(this.local.deviceId, note, peerId);
    if (!body) throw new Error("invalid note");
    await this.sendEncryptedTo(peerId, peer, body);
  }

  async sendNoteDelete(note: { id: string; updatedAt: number }): Promise<void> {
    if (!noteDeleteBody(this.local.deviceId, note)) {
      throw new Error("invalid note delete");
    }
    await this.fanOutShared((peerId) =>
      noteDeleteBody(this.local.deviceId, note, peerId),
    );
  }

  async sendNoteDeleteTo(
    peerId: string,
    note: { id: string; updatedAt: number },
  ): Promise<void> {
    const peer = this.peerMap.get(peerId);
    if (!peer) throw new Error(`host ${peerId} not paired`);
    const body = noteDeleteBody(this.local.deviceId, note, peerId);
    if (!body) throw new Error("invalid note delete");
    await this.sendEncryptedTo(peerId, peer, body);
  }

  async sendSecretUpsert(secret: {
    id: string;
    updatedAt: number;
    ciphertext: string;
    nonce: string;
    meta: SecretUpsertPayload["meta"];
  }): Promise<void> {
    if (!secretUpsertBody(this.local.deviceId, secret)) {
      throw new Error("invalid secret");
    }
    await this.fanOutShared((peerId) =>
      secretUpsertBody(this.local.deviceId, secret, peerId),
    );
  }

  async sendSecretUpsertTo(
    peerId: string,
    secret: {
      id: string;
      updatedAt: number;
      ciphertext: string;
      nonce: string;
      meta: SecretUpsertPayload["meta"];
    },
  ): Promise<void> {
    const peer = this.peerMap.get(peerId);
    if (!peer) throw new Error(`host ${peerId} not paired`);
    const body = secretUpsertBody(this.local.deviceId, secret, peerId);
    if (!body) throw new Error("invalid secret");
    await this.sendEncryptedTo(peerId, peer, body);
  }

  async sendSecretDelete(secret: {
    id: string;
    updatedAt: number;
  }): Promise<void> {
    if (!secretDeleteBody(this.local.deviceId, secret)) {
      throw new Error("invalid secret delete");
    }
    await this.fanOutShared((peerId) =>
      secretDeleteBody(this.local.deviceId, secret, peerId),
    );
  }

  async sendSecretDeleteTo(
    peerId: string,
    secret: { id: string; updatedAt: number },
  ): Promise<void> {
    const peer = this.peerMap.get(peerId);
    if (!peer) throw new Error(`host ${peerId} not paired`);
    const body = secretDeleteBody(this.local.deviceId, secret, peerId);
    if (!body) throw new Error("invalid secret delete");
    await this.sendEncryptedTo(peerId, peer, body);
  }

  async sendVaultKeyShare(keyHex: string): Promise<void> {
    if (!vaultKeyShareBody(this.local.deviceId, keyHex)) {
      throw new Error("invalid vault key");
    }
    await this.fanOutShared((peerId) =>
      vaultKeyShareBody(this.local.deviceId, keyHex, peerId),
    );
  }

  async sendVaultKeyShareTo(peerId: string, keyHex: string): Promise<void> {
    const peer = this.peerMap.get(peerId);
    if (!peer) throw new Error(`host ${peerId} not paired`);
    const body = vaultKeyShareBody(this.local.deviceId, keyHex, peerId);
    if (!body) throw new Error("invalid vault key");
    await this.sendEncryptedTo(peerId, peer, body);
  }
}
