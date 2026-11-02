# involvex Sync architecture

## Clients

| App             | Role                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `apps/desktop`  | Tauri 2 tray app. Listens on TCP `17391` (WebSocket). Opens http(s) URLs. |
| `apps/mobile`   | Expo development build. Connects outbound. Share intent + notifications.  |
| `workers/relay` | Cloudflare Durable Object. Ciphertext mailbox with short offline queue.   |

## Trust model

1. Devices generate Ed25519 + X25519 keypairs locally.
2. Pairing exchanges public keys via QR / pasted JSON in the same room.
3. Every frame is sealed (`X25519` + `XChaCha20-Poly1305`) and signed (`Ed25519`).
4. The relay stores and forwards opaque frames only.

## Transport preference

1. **LAN** — phone dials `ws://<desktop-ip>:17391` (preferred at home).
2. **MyFritz** — same encrypted frames to a forwarded host/port (optional).
3. **Cloudflare relay** — both sides dial `wss://sync.involvex.workers.dev/ws` when away.

## Android constraints

- Background clipboard read is blocked (Android 10+). Share sheet is the reliable path.
- Opening a browser from the background uses a high-priority notification; tap runs `ACTION_VIEW`.
- Keepalive uses a `dataSync` foreground service so the WebSocket can stay up.

## Termux (allowlist)

Later: `termux_open_url` / `termux_clipboard_set` map to Termux:API. Free shell is out of scope for v0.1.
