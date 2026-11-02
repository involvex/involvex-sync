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

InVx Termux package: `com.involvex.termux_app`.

- Termux **defines** `com.involvex.termux_app.permission.RUN_COMMAND` (`dangerous`).
- `RunCommandService` is `exported` and gated by that permission.
- involvex Sync must `uses-permission` it, add `<queries>` for the package,
  request it at runtime, then `startForegroundService` with action
  `com.involvex.termux_app.RUN_COMMAND`.
- Only allowlisted binaries (`termux-open-url`, `termux-clipboard-set`) — no free shell.

## Notification mirror

- Opt-in on both sides (default off).
- Phone: `NotificationListenerService` + setting “Mirror to PC”.
- Desktop: setting “Show phone notifications” → OS toast via
  `tauri-plugin-notification`.
- Wire payload: encrypted `notification_mirror` (title, body, package?, when).

## Desktop tray

- Close / minimize hides the main window; process stays in the system tray.
- Tray menu: Open / Quit. Left-click restores the window.

## Sync Keyboard (PC → phone)

1. Protocol: `keyboard_text` / `keyboard_key` (allowlisted) + optional
   `keyboard_status` from the phone when the IME is active.
2. Android `InputMethodService` (`invx-ime`) — user enables and selects
   “involvex Sync Keyboard”; never auto-enable.
3. Kill switches: phone “Receive keyboard from PC”, desktop “Send keys to phone”.
4. Out of scope: Bluetooth HID, mouse/touchpad, gamepad.

## Chunked file transfer

- `file_offer` / `file_chunk` / `file_done` / `file_abort` (encrypted).
- Soft cap 100 MiB; legacy single `file_transfer` for small payloads.

## Find phone

- Desktop → phone `find_phone` (default ~30 s).
- Phone: full-screen overlay + vibration + high-priority notification; dismiss stops.
