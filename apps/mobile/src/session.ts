import {
  type DeviceKeys,
  type DeviceType,
  type KeyboardKeyId,
  LoopGuard,
  type MessageBody,
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
  private ws: WebSocket | null = null;
  private handlers: SessionHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private transport: TransportConfig | null = null;
  private peerId: string | undefined;
  private pairingMode = false;
  private identityMeta: { name: string; type: DeviceType };
  private assemblers = new Map<string, ChunkAssembler>();

  constructor(stored: StoredDeviceKeys, handlers: SessionHandlers) {
    this.local = toDeviceKeys(stored);
    this.handlers = handlers;
    this.identityMeta = { name: stored.name, type: "android" };
  }

  setPeer(peer: StoredPeer): void {
    this.peer = {
      deviceId: peer.deviceId,
      ed25519PublicKey: peer.ed25519PublicKey,
      x25519PublicKey: peer.x25519PublicKey,
    };
    this.peerId = peer.deviceId;
  }

  clearPeer(): void {
    this.peer = null;
    this.peerId = undefined;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(transport: TransportConfig, opts?: { pairing?: boolean }): void {
    this.disconnect();
    this.transport = transport;
    this.pairingMode = opts?.pairing === true;
    let url: string;
    try {
      url = resolveWsUrl(transport, this.local.deviceId, this.peerId);
    } catch (e) {
      this.handlers.onStatus(`error: ${String(e)}`);
      return;
    }

    this.handlers.onStatus(`connecting ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

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
      this.handlers.onStatus("disconnected");
      if (!this.pairingMode) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.transport) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.transport) this.connect(this.transport);
    }, 2_500);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pairingMode = false;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  async handleIncomingRaw(raw: string): Promise<void> {
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
        this.disconnect();
        return;
      }
      return;
    }

    if (!this.peer) {
      this.handlers.onLog("drop: no peer");
      return;
    }
    const frame = parseFrame(raw);
    if (!frame) {
      this.handlers.onLog("drop: bad frame");
      return;
    }
    const result = decryptFrame(frame, this.local, this.peer);
    if (!result.ok) {
      this.handlers.onLog(`drop: ${result.error}`);
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

  private sendFrame(body: MessageBody): void {
    if (!this.peer || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const frame = encryptFrame(body, this.local, this.peer);
    this.ws.send(serializeFrame(frame));
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

  sendNotificationMirror(note: {
    title: string;
    body: string;
    packageName?: string;
    when?: number;
  }): void {
    if (!this.peer) throw new Error("not connected");
    this.sendFrame(
      notificationMirrorBody(this.local.deviceId, note, this.peer.deviceId),
    );
  }

  sendKeyboardStatus(active: boolean, mode?: "ime" | "a11y" | "none"): void {
    if (!this.peer || !this.isOpen) return;
    try {
      this.sendFrame(
        keyboardStatusBody(
          this.local.deviceId,
          active,
          this.peer.deviceId,
          mode,
        ),
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

  sendNoteUpsert(note: {
    id: string;
    title: string;
    body: string;
    updatedAt: number;
  }): void {
    const body = noteUpsertBody(this.local.deviceId, note, this.peer?.deviceId);
    if (!body) throw new Error("invalid note");
    this.sendFrame(body);
  }

  sendNoteDelete(note: { id: string; updatedAt: number }): void {
    const body = noteDeleteBody(this.local.deviceId, note, this.peer?.deviceId);
    if (!body) throw new Error("invalid note delete");
    this.sendFrame(body);
  }

  sendSecretUpsert(secret: {
    id: string;
    updatedAt: number;
    ciphertext: string;
    nonce: string;
    meta: SecretUpsertPayload["meta"];
  }): void {
    const body = secretUpsertBody(
      this.local.deviceId,
      secret,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid secret");
    this.sendFrame(body);
  }

  sendSecretDelete(secret: { id: string; updatedAt: number }): void {
    const body = secretDeleteBody(
      this.local.deviceId,
      secret,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid secret delete");
    this.sendFrame(body);
  }

  sendVaultKeyShare(keyHex: string): void {
    const body = vaultKeyShareBody(
      this.local.deviceId,
      keyHex,
      this.peer?.deviceId,
    );
    if (!body) throw new Error("invalid vault key");
    this.sendFrame(body);
  }
}
