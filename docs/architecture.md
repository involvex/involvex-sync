# involvex Sync architecture

## Clients

| App             | Role                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `apps/desktop`  | Tauri 2 tray app. Listens on TCP `17391` (WebSocket). Opens http(s) URLs. |
| `apps/mobile`   | Expo development build. Connects outbound. Share intent + notifications.  |
| `workers/relay` | Cloudflare Durable Object. Ciphertext mailbox with short offline queue.   |

## Trust model

1. Devices generate Ed25519 + X25519 keypairs locally.
2. Pairing exchanges public keys via QR / Nearby Pair / Scan PC QR / pasted JSON in the same room.
3. Every frame is sealed (`X25519` + `XChaCha20-Poly1305`) and signed (`Ed25519`).
4. The relay stores and forwards opaque frames only.

## Pairing UX

1. Phone Nearby Pair opens `ws://` and sends `pair_request`. Desktop always OS-notifies
   and calls `show_main_window` (even when tray-hidden). Accept/Reject stays pinned.
2. Desktop QR is the same JSON as Advanced paste; phone **Scan PC QR** uses `expo-camera`.
3. Android allows cleartext for LAN (`usesCleartextTraffic`) so `ws://` works.
4. Desktop frontend queues early `ws-message` events until the React session mounts.
5. Send / Find / Sync Keyboard gate on live `peerConnected`, not only a stored peer.
6. Relay is for away-from-home; it is not a substitute for LAN pair.

## Transport preference

1. **LAN** — phone dials `ws://<desktop-ip>:17391` (preferred at home).
2. **MyFritz** — same encrypted frames to a forwarded host/port (optional).
3. **Cloudflare relay** — both sides dial `wss://sync.involvex.workers.dev/ws` when away.

## Auto clipboard sync

- Opt-in on **both** sides (default off): auto text + optional images.
- Desktop watches the OS clipboard while Live and pushes changes.
- Phone pushes when the app is foreground **or** Sync Keyboard IME is
  selected (IME may read clipboard on Android 10+). Share / Send remain.
- Images travel as chunked `file_*` with `purpose: "clipboard"` (≤2 MiB).
- Clipboard sync never auto-opens URLs (stays on `clipboard_update` + history).
  Use the explicit Send link UI for `share_url` open-in-browser.
- Echo suppression uses `LoopGuard` on text or image content hash.
- Not Microsoft Phone Link — same E2E stack as the rest of Sync.
- **Future (not built):** true background phone→PC without IME could use
  **Shizuku** (privileged clipboard binder as shell UID) or an overlay
  focus trick. Shizuku needs the Shizuku app authorized + restarted after
  reboot; OEM battery killers still apply. Keep Share / IME as defaults.

## Android constraints

- Background clipboard read is blocked (Android 10+). Share sheet is the
  reliable path; auto sync needs foreground or Sync Keyboard IME.
- Opening a browser from the background uses a high-priority notification; tap runs `ACTION_VIEW`.
- Keepalive uses a `dataSync` foreground service so the WebSocket can stay up.
- Cleartext `ws://` LAN is allowed via config plugin `plugins/withCleartextTraffic.js`
  (requires a native rebuild after change).

## Termux (allowlist)

InVx Termux package: `com.involvex.termux_app`.

- Termux **defines** `com.involvex.termux_app.permission.RUN_COMMAND` (`dangerous`).
- `RunCommandService` is `exported` and gated by that permission.
- involvex Sync must `uses-permission` it, add `<queries>` for the package,
  request it at runtime, then `startForegroundService` with action
  `com.involvex.termux_app.RUN_COMMAND`.
- Paths use `$PREFIX/bin/...` (Termux expands). Remote shell is allowlisted
  `bash -lc` when “Allow remote Termux” is on.
- **Phone setup (otherwise commands silently do nothing):**
  1. In `~/.termux/termux.properties` set `allow-external-apps=true`, restart Termux.
  2. Grant Sync the RUN_COMMAND permission when prompted.
  3. For `termux-toast` / `termux-open-url`: `pkg install termux-api`
     (and Termux:API companion app if your build needs it).

## Notification mirror

- Opt-in on both sides (default off).
- Phone: `NotificationListenerService` + setting “Mirror to PC”.
- Desktop: setting “Show phone notifications” → OS toast via
  `tauri-plugin-notification`.
- Wire payload: encrypted `notification_mirror` (title, body, package?, when).

## Desktop tray

- Close / minimize hides the main window; process stays in the system tray.
- Tray menu: Open / Quit. Left-click restores the window.
- Startup shows the window and ignores minimize-to-tray for ~3s (avoids a
  Windows resize race that left release builds tray-only).
- Loopback control API on `127.0.0.1:17392` for the `isync` CLI
  (`share`, `clipboard`, `find`, `show`, `status`).

## Files + remote commands

- Incoming files: configurable folder (desktop path; phone Documents subfolder).
- Desktop Files tab sends via HTML file picker; phone uses document picker /
  Android Share.
- **Folder sync (PC → phone):** opt-in watch on a PC directory (default
  `I:\Downloads\Involvex-Sync`). New/changed files debounce then send via the
  existing chunked transfer into the phone SAF save folder. Subpaths flatten
  (`sub/a.pdf` → `sub__a.pdf`). Ledger in localStorage avoids re-sends. Soft
  cap 100 MiB; offline queue flushes when Live again.
- **Folder sync (PC → Google Drive):** same watcher; opt-in second sink shells
  out to `gws drive +upload` (credentials from `gws auth login`). Separate
  Drive ledger in localStorage. Does not require the phone to be Live.
- **Phone → Drive:** Expo app uses Drive REST + OAuth (`drive.file`). Dedicated
  Worker `workers/oauth-token-exchange` (`involvex-sync-oauth`): `GET /oauth`
  HTTPS bridge → `involvex-sync://oauth`; `POST /token` exchanges code+PKCE with
  the Web client secret (awesome-github-app pattern). Config via
  `app.json` / `app.config.js` `extra.oauth`.
- `remote_command`: phone → PowerShell on PC (opt-in); PC → Termux bash on
  phone (opt-in); PC also runs local `adb shell` without the wire protocol.

## Sync Keyboard (PC → phone)

1. Protocol: `keyboard_text` / `keyboard_key` (allowlisted) + optional
   `keyboard_status` from the phone when the IME is active.
2. Android `InputMethodService` (`invx-ime`) — user enables and selects
   “involvex Sync Keyboard”; never auto-enable.
3. Optional `AccessibilityService` (`invx-a11y`) injects into the focused
   field when IME is not selected. Separate opt-in toggle; never auto-enable.
4. Gate: IME wins if active+enabled; else a11y if enabled+granted.
5. Phone reports `keyboard_status` with `active` + `mode` (`ime` | `a11y` |
   `none`) so the desktop Sync Keyboard tab unlocks for either path.
6. CLI: `isync keyboard type …` / `isync keyboard key enter` via loopback
   control (`POST /v1/keyboard`).
7. Kill switches: phone receive toggles, desktop “Send keys to phone”.
8. Out of scope: Bluetooth HID, mouse/touchpad, gamepad, screen scraping.

## Chunked file transfer

- `file_offer` / `file_chunk` / `file_done` / `file_abort` (encrypted).
- Soft cap 100 MiB; legacy single `file_transfer` for small payloads.

## Find phone

- Desktop → phone `find_phone` (default ~30 s).
- Phone: full-screen overlay + vibration + high-priority notification; dismiss stops.
