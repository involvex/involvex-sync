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

## Follow-up: keyboard receiver (not implemented)

PC types into the focused Android field as if Sync were a soft keyboard.

1. Protocol: `keyboard_text` / `keyboard_key` (allowlisted), gated by paired +
   settings on both ends.
2. Android `InputMethodService` (“involvex Sync Keyboard”) — user must select
   it as the IME; never auto-enable.
3. Desktop: small input UI / send-on-enter; visible “typing to phone” indicator;
   kill switch on both sides.
4. Out of scope for v1: Bluetooth HID, mouse/touchpad, gamepad.
