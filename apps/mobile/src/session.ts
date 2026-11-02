import {
  type DeviceKeys,
  type DeviceType,
  type KeyboardKeyId,
  LoopGuard,
  type MessageBody,
  type PairAcceptPayload,
  type PeerPublicKeys,
  ChunkAssembler,
  buildPairRequest,
  clipboardUpdateBody,
  decryptFrame,
  encryptFrame,
  fileAbortBody,
  fileChunkBody,
  fileDoneBody,
  fileOfferBody,
  fileTransferBody,
  keyboardStatusBody,
  notificationMirrorBody,
  parseAllowedUrl,
  parseFrame,
  parsePairHandshake,
  planChunkedTransferFromBase64,
  randomBytes,
  serializeFrame,
  shareUrlBody,
  bytesToHex,
} from "@involvex/protocol";
import type { StoredDeviceKeys, StoredPeer } from "./identity";
import { toDeviceKeys } from "./identity";
import { type TransportConfig, resolveWsUrl } from "./transport";

export type SessionHandlers = {
  onShareUrl: (url: string, from: string) => void | Promise<void>;
  onClipboard: (text: string, from: string) => void | Promise<void>;
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
  onPairAccept?: (accept: PairAcceptPayload) => void | Promise<void>;
  onPairReject?: (reason?: string) => void | Promise<void>;
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
            `file offer ${payload.name} (${payload.size} B, ${payload.totalChunks} chunks)`,
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
          const dataBase64 = asm.finishBase64(payload.sha256);
          await this.handlers.onFileTransfer?.(
            {
              name: asm.name,
              mimeType: asm.mimeType,
              dataBase64,
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
      default:
        this.handlers.onLog(`recv ${payload.type}`);
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

  sendFile(file: {
    name: string;
    mimeType: string;
    dataBase64: string;
    size: number;
  }): void {
    if (!this.peer) throw new Error("not connected");
    // Prefer chunked for anything non-trivial; keep legacy for tiny files.
    if (file.size <= 64 * 1024) {
      this.sendFrame(
        fileTransferBody(this.local.deviceId, file, this.peer.deviceId),
      );
      return;
    }
    const transferId = bytesToHex(randomBytes(8));
    const plan = planChunkedTransferFromBase64(
      transferId,
      file.name,
      file.mimeType,
      file.dataBase64,
    );
    this.sendFrame(
      fileOfferBody(
        this.local.deviceId,
        {
          transferId: plan.transferId,
          name: plan.name,
          mimeType: plan.mimeType,
          size: plan.size,
          totalChunks: plan.totalChunks,
        },
        this.peer.deviceId,
      ),
    );
    plan.chunks.forEach((dataBase64, index) => {
      this.sendFrame(
        fileChunkBody(
          this.local.deviceId,
          { transferId, index, dataBase64 },
          this.peer!.deviceId,
        ),
      );
    });
    this.sendFrame(
      fileDoneBody(
        this.local.deviceId,
        { transferId, sha256: plan.sha256 },
        this.peer.deviceId,
      ),
    );
    this.handlers.onLog(
      `sent file ${plan.name} (${plan.size} B, ${plan.totalChunks} chunks)`,
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

  sendKeyboardStatus(active: boolean): void {
    if (!this.peer || !this.isOpen) return;
    try {
      this.sendFrame(
        keyboardStatusBody(this.local.deviceId, active, this.peer.deviceId),
      );
    } catch {
      /* ignore */
    }
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
}
