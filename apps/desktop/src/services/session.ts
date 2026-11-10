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
  onLog: (line: string) => void;
};

export class SyncSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  /** Active peer — everything outbound is sealed for this device. */
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
  private relaySend: ((raw: string) => void) | null = null;
  private assemblers = new Map<string, ChunkAssembler>();

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
   * Null (default) = LAN only, matching the pre-relay behavior.
   */
  setRelaySender(send: ((raw: string) => void) | null): void {
    this.relaySend = send;
  }

  async handleIncomingRaw(raw: string, connId?: number): Promise<void> {
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
    if (connId !== undefined) {
      this.connByDevice.set(frame.from, connId);
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
        return this.sendViaRelay(raw, e);
      }
    }

    // No mapping for the active peer. `ws_send` is only safe while a single
    // device is paired; with several it could reach the wrong socket, so go
    // straight to the relay, which is addressed per peer.
    if (this.peerMap.size > 1) {
      return this.sendViaRelay(
        raw,
        "active device socket unknown (several devices paired)",
      );
    }

    try {
      await invoke("ws_send", { message: raw });
      return;
    } catch (e) {
      return this.sendViaRelay(raw, e);
    }
  }

  private sendViaRelay(raw: string, lanError: unknown): Promise<void> {
    const reason =
      lanError instanceof Error ? lanError : new Error(String(lanError));
    if (!this.relaySend) return Promise.reject(reason);
    this.handlers.onLog(
      `relay: LAN send failed (${String(lanError)}), using relay`,
    );
    try {
      this.relaySend(raw);
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
        this.handlers.onLog(`file abort ${payload.transferId}`);
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
        },
        this.peer.deviceId,
      ),
    );
    const iter = iterateFileChunks(file.data);
    let step = iter.next();
    let sent = 0;
    while (!step.done) {
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
    if (!this.peer) return;
    void this.sendBody(
      fileAbortBody(
        this.local.deviceId,
        { transferId, reason },
        this.peer.deviceId,
      ),
    );
  }

  async sendNoteUpsert(note: {
    id: string;
    title: string;
    body: string;
    updatedAt: number;
  }): Promise<void> {
    const body = noteUpsertBody(this.local.deviceId, note, this.peer?.deviceId);
    if (!body) throw new Error("invalid note");
    await this.sendBody(body);
  }

  async sendNoteDelete(note: { id: string; updatedAt: number }): Promise<void> {
    const body = noteDeleteBody(this.local.deviceId, note, this.peer?.deviceId);
    if (!body) throw new Error("invalid note delete");
    await this.sendBody(body);
  }

  async sendSecretUpsert(secret: {
    id: string;
    updatedAt: number;
    ciphertext: string;
    nonce: string;
    meta: SecretUpsertPayload["meta"];
  }): Promise<void> {
    const body = secretUpsertBody(
      this.local.deviceId,
      secret,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid secret");
    await this.sendBody(body);
  }

  async sendSecretDelete(secret: {
    id: string;
    updatedAt: number;
  }): Promise<void> {
    const body = secretDeleteBody(
      this.local.deviceId,
      secret,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid secret delete");
    await this.sendBody(body);
  }

  async sendVaultKeyShare(keyHex: string): Promise<void> {
    const body = vaultKeyShareBody(
      this.local.deviceId,
      keyHex,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid vault key");
    await this.sendBody(body);
  }
}
