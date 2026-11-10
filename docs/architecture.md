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
- **Drive browsing (read-only):** the desktop Files tab lists My Drive with
  `gws drive files list` (50 per page, `'root' in parents`, newest first).
  Folder rows drill down, files open in the Drive web UI via the URL
  allowlist, and "Use as sync folder" writes the folder id into settings.
  No uploads/deletes from the browser; each list action is one `gws` spawn.
- All desktop shell-outs (`gws`, `adb`, `pwsh`, `netsh`) are spawned with
  `CREATE_NO_WINDOW` so release builds (GUI subsystem, no console) never
  flash a console window. Argv-only, no shell; child pipes are drained on
  reader threads so large JSON pages cannot deadlock the capture.
- **Phone → Drive:** Expo app uses Drive REST + OAuth (`drive.file`). Dedicated
  Worker `workers/oauth-token-exchange` (`involvex-sync-oauth`): `GET /oauth`
  HTTPS bridge → `involvex-sync://oauth`; `POST /token` exchanges code+PKCE with
  the Web client secret (awesome-github-app pattern). Config via
  `app.json` / `app.config.js` `extra.oauth`.
- `remote_command`: phone → PowerShell on PC (opt-in); PC → Termux bash on
  phone (opt-in); PC also runs local `adb shell` without the wire protocol.
- **Local ADB (screenshot + shell):** Rust exposes `adb_devices` (raw
  `adb devices -l`), `adb_screencap {serial?}` and `run_adb_shell
{command, serial?}`. `exec-out screencap -p` output is drained on a reader
  thread from the moment of spawn — reading stdout only after exit deadlocked
  the capture on multi-MB PNGs (pipe fills → adb blocks → parent never sees
  exit). Parsing/serial selection lives in `services/adbDevices.ts`
  (`parseAdbDevices`, `resolveSerial`): saved `adbSerial` → auto-pick when
  exactly one usable device → error with a reason (`offline`,
  `unauthorized`, `ambiguous`, `no-device`). A saved serial that vanished or
  went unauthorized falls through instead of failing. mDNS/TLS serials are
  treated as hints, never identities.

## Multi-host pairing (full mesh)

Every device pairs with every other device — phone + PC + laptop is the
supported topology. Each pairing is an independent, symmetric relationship.

- **Storage:** keyring/SecureStore hold a _list_ of peers (`load_peers`,
  `save_peer`, `remove_peer`, `clear_peers`). The old single-peer slot is read
  once and folded in on first access (seed-on-read migration), then deleted.
  A pairing carries the last reachable `host`/`port` as a reconnect hint.
- **Routing:** `WireFrame.from` is cleartext, so the receiving session picks
  the decryption key by _sender identity_ instead of "the one peer". `body.to`
  is now enforced: a frame addressed to a different device id is dropped.
  The phone sends a `ping` immediately after connecting, which is what tells
  the desktop which socket belongs to which device.
- **Active peer:** each side has one send target (desktop dropdown / mobile
  “Use”). Clipboard, files, find-phone and remote commands go to the active
  device; notes, secrets and the vault key are shared state and go to every
  connected host.
- **Pairing replies:** pair requests are queued with the socket they arrived
  on, so `accept`/`reject` answer on the same connection.
- **Desktop sockets:** one task per connection (`ws.rs`), keyed by conn id.
  The session keeps a `deviceId → connId` map learned from inbound frames, so
  outbound frames go to the _selected_ device via `ws_send_to`, not whichever
  socket connected last. `ws_send` remains the fallback when no mapping is
  known; `ws_conns` lists live sockets and `ws_close` drops one (unpairing
  closes the removed device's socket). Heartbeat pings every 15 s, dead peers
  reaped after 75 s of silence.
- **Phone sockets:** one WebSocket per paired host with its own backoff, so a
  sleeping PC does not block the laptop connection.

## Connectivity hardening

- **Relay self-id:** the room used to guess which half of `A:B` a connector
  was; a reconnecting device took the _other_ half and both peers silently
  stopped receiving. Clients now send `?self=<deviceId>` and the worker
  accepts it **only when it is one of the pair's two ids** (otherwise it falls
  back to the old guess) — otherwise anyone holding the pair string could sit
  in the room as a third, unremovable listener. The worker replaces a stale
  socket for that id, and `sanitizeId` rejects ids containing a colon.
- **Reconnect backoff:** flat 2.5 s retries hammered a sleeping PC and drained
  the phone battery. Now 2.5 s → 5 s → 10 s … capped at 60 s, reset on open.
- **Relay fallback for everything:** `sendRaw` tries the LAN socket first and
  falls back to the relay for any payload type — clipboard, files, notes,
  keyboard, links and commands — not just share links.
- **Firewall:** the inbound rule is `profile=any` (was private-only) because a
  laptop on public Wi-Fi or a phone hotspot is classified public. Pairing is
  still the gate, not the network profile.
- **Ping/Pong:** tungstenite never answers pings itself; unanswered pings made
  the peer's keepalive logic drop the connection.

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
