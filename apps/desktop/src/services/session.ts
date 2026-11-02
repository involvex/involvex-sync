import {
  type DeviceKeys,
  type DeviceType,
  type KeyboardKeyId,
  LoopGuard,
  type MessageBody,
  type PairRequestPayload,
  type PeerPublicKeys,
  ChunkAssembler,
  buildPairAccept,
  buildPairReject,
  bytesToHex,
  clipboardUpdateBody,
  decryptFrame,
  encryptFrame,
  fileAbortBody,
  fileChunkBody,
  fileDoneBody,
  fileOfferBody,
  fileTransferBody,
  findPhoneBody,
  keyboardKeyBody,
  keyboardTextBody,
  parseAllowedUrl,
  parseFrame,
  parsePairHandshake,
  planChunkedTransferFromBase64,
  randomBytes,
  serializeFrame,
  shareUrlBody,
} from "@involvex/protocol";
import { invoke } from "@tauri-apps/api/core";
import type { StoredPeer } from "./identity";
import { type StoredDeviceKeys, toDeviceKeys } from "./identity";

export type SessionHandlers = {
  onShareUrl: (url: string, from: string) => void | Promise<void>;
  onClipboard: (text: string, from: string) => void | Promise<void>;
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
  onKeyboardStatus?: (active: boolean) => void | Promise<void>;
  onPairRequest?: (request: PairRequestPayload) => void | Promise<void>;
  onLog: (line: string) => void;
};

export class SyncSession {
  readonly local: DeviceKeys;
  readonly loop = new LoopGuard();
  peer: PeerPublicKeys | null = null;
  private handlers: SessionHandlers;
  private identityMeta: { name: string; type: DeviceType };
  private pendingPairDeviceId: string | null = null;
  private assemblers = new Map<string, ChunkAssembler>();

  constructor(stored: StoredDeviceKeys, handlers: SessionHandlers) {
    this.local = toDeviceKeys(stored);
    this.handlers = handlers;
    this.identityMeta = { name: stored.name, type: "windows" };
  }

  setPeer(peer: StoredPeer): void {
    this.peer = {
      deviceId: peer.deviceId,
      ed25519PublicKey: peer.ed25519PublicKey,
      x25519PublicKey: peer.x25519PublicKey,
    };
  }

  clearPeer(): void {
    this.peer = null;
  }

  async handleIncomingRaw(raw: string): Promise<void> {
    const handshake = parsePairHandshake(raw);
    if (handshake) {
      if (handshake.kind === "involvex-sync-pair-request") {
        this.pendingPairDeviceId = handshake.device.deviceId;
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
    const result = decryptFrame(frame, this.local, this.peer);
    if (!result.ok) {
      this.handlers.onLog(`drop: ${result.error}`);
      return;
    }
    await this.dispatch(result.body);
  }

  async acceptPair(
    _request: PairRequestPayload,
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
    await invoke("ws_send", { message: JSON.stringify(accept) });
    this.pendingPairDeviceId = null;
  }

  async rejectPair(reason?: string): Promise<void> {
    const deviceId = this.pendingPairDeviceId ?? this.local.deviceId;
    const reject = buildPairReject(deviceId, reason);
    try {
      await invoke("ws_send", { message: JSON.stringify(reject) });
    } catch {
      /* peer may already be gone */
    }
    this.pendingPairDeviceId = null;
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
        await this.handlers.onKeyboardStatus?.(payload.active);
        break;
      }
      case "ping":
      case "pong":
      case "pair_ack":
        this.handlers.onLog(`recv ${payload.type}`);
        break;
      default:
        this.handlers.onLog("drop: unknown payload");
    }
  }

  private async sendBody(body: MessageBody): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    const frame = encryptFrame(body, this.local, this.peer);
    await invoke("ws_send", { message: serializeFrame(frame) });
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

  async sendFile(file: {
    name: string;
    mimeType: string;
    dataBase64: string;
    size: number;
  }): Promise<void> {
    if (!this.peer) throw new Error("no peer paired");
    if (file.size <= 64 * 1024) {
      await this.sendBody(
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
    await this.sendBody(
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
    for (const [index, dataBase64] of plan.chunks.entries()) {
      await this.sendBody(
        fileChunkBody(
          this.local.deviceId,
          { transferId, index, dataBase64 },
          this.peer.deviceId,
        ),
      );
    }
    await this.sendBody(
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
}
