# involvex Sync — Feature Suggestions

Analysis of the repository as it stands today (protocol v1, Bun workspaces,
`@involvex/protocol`, Tauri desktop, Expo Android app, Cloudflare relay workers).
This document lists features that are **not yet implemented** but fit the
existing architecture and trust model. Every item names the files/subsystems it
would touch so it can be turned into an implementation plan directly.

Effort key: **S** ≈ half a day, **M** ≈ 1–3 days, **L** ≈ 1+ week (often needs a
native rebuild or a protocol change).

## Baseline — what already exists

Do not re-implement these; build on them:

- Full-mesh pairing (QR / Nearby / paste), Ed25519 + X25519 identity, sealed
  frames (`XChaCha20-Poly1305`) signed with Ed25519 — `packages/protocol`.
- LAN WebSocket (`ws://…:17391`) with Cloudflare Durable-Object relay fallback,
  signed relay hello, per-peer rooms, offline queue — `workers/relay`.
- Text + image clipboard sync, shared text clipboard history, loop guard,
  opt-in Shizuku background text polling.
- URL share → `open_allowed_url` (strict `http(s)` allowlist), Find phone.
- Chunked files (100 MiB soft cap, `relativePath`), folder sync PC→phone,
  phone→PC (SAF tree), PC→Google Drive, read-only Drive browser, OAuth worker.
- Notification mirror, local ADB screenshot/shell, scrcpy/Escrcpy mirror,
  Sync Keyboard (IME + accessibility), remote PowerShell/Termux commands.
- Notes + encrypted secrets vault, vault-key catch-up, multi-host fan-out.
- Tauri tray app with loopback control API (`127.0.0.1:17392`) and the `isync`
  CLI; 7 UI themes; manual mobile tab navigation.

---

## A. Quick wins — reuse existing stores and payloads

### A1. Clipboard history: search, pin/favourites, retention settings — **S**
The history store (`apps/desktop/src/services/clipboardHistory.ts`,
`apps/mobile/src/clipboardHistory.ts`) is a flat 50-row list with no filtering.
Add a local `pinned` flag, a text query filter, and configurable retention.
Wire a search field into the desktop **History** tab and the mobile Home screen,
plus `isync clipboard history --query <text>`. Pins stay local (like image
history) so nothing new goes on the wire.

### A2. Device nicknames, colours and status in the tray — **S**
`StoredPeer` (`apps/desktop/src/services/identity.ts`) has only `name` and
`deviceId`. Add an editable `label` + `color`, show it in the Connection tab,
mobile Connection screen and peer chips, and reflect the active device in the
tray tooltip / menu. Small change, big usability gain in a multi-host mesh.

### A3. Connection quality (RTT) indicator — **S**
`ping`/`pong` payloads already exist in `packages/protocol/src/types.ts`. Measure
round-trip time in `apps/desktop/src/services/session.ts` and
`apps/mobile/src/session.ts`, expose it in `StatusBody`
(`apps/desktop/src-tauri/src/control.rs`), and show a latency badge in the
status strip and `isync status`. Also distinguishes LAN from relay paths.

### A4. `isync --json` + shell completions — **S**
`apps/cli/src/isync.ts` prints human text only. Add a global `--json` flag that
emits machine-readable objects for `status`, `peers`, `notes` and `clipboard
history`, and generate PowerShell/Bash/Zsh completion scripts under `scripts/`.
Makes the CLI scriptable without changing the control API.

### A5. Windows "Send to phone" context menu + drag-and-drop — **S/M**
`Plan.md` phase 6 explicitly wanted a Windows context menu. Add a registry
install/uninstall script in `scripts/` that calls `isync share <url>` and
`isync file <path>` (both endpoints already exist in `control.rs`), and accept
file/URL drops on the desktop window in `apps/desktop/src/App.tsx`. Reuse
`parseAllowedUrl` — no new protocol work.

### A6. Biometric/quick unlock for the secrets vault — **S/M**
`expo-local-authentication` is already a mobile dependency. Add optional
biometric unlock, an auto-lock timeout, and "copy value, clear clipboard after
N seconds" to the secrets panel (`apps/desktop/src/components/NotesVaultPanel.tsx`,
`apps/mobile/src/secretsStore.ts`). Pure client-side; vault AEAD unchanged.

---

## B. Device & OS integration — small protocol additions

### B1. Device status telemetry (battery, charging, Wi-Fi) — **M**
KDE Connect-style: phone periodically sends a `device_status` payload
(battery %, charging, optional SSID) over the existing encrypted session.
Desktop shows it in the tray / Connection tab; `expo-battery` would be added
with `bunx expo install` per mobile AGENTS.md. **Files:** `types.ts` (new
payload), `session.ts` on both clients, `App.tsx` Connection tab, `control.rs`
snapshot. Text-only, ≤8 KiB → relay offline queue compatible.

### B2. "Speak on phone" (TTS) — **M**
A first-class `speak_text` payload (or a named `remote_command` preset) that
the phone reads aloud via Android `TextToSpeech` / `termux-tts-speak`. Adds a
desktop Send-tab button and `isync speak "…"`. Plan.md phase 9 listed TTS;
the allowlisted Termux path already exists, so this is mostly UX + a tiny
native module.

### B3. Camera photo and torch control — **M/L**
Plan.md phase 9 listed `termux-camera-photo` and `termux-torch`. Add
`camera_capture` and `torch_set` payloads with explicit phone-side opt-ins,
capture via `expo-camera` (already installed), and return the image through the
existing clipboard-purpose/file transfer path. Requires a native dev-client
rebuild and careful permission gating.

### B4. Media session control — **M/L**
Mirror Android media metadata (title/artist/album/artwork) and accept
play/pause/next/prev/volume commands from the desktop. The notification
listener module (`apps/mobile/modules/invx-notify`) is the natural hook; add a
`media_state` / `media_control` payload pair and a desktop HUD. This is the
single most "Phone Link"-like missing feature.

### B5. Interactive notification replies — **M**
Extend `notification_mirror` with optional reply action metadata; desktop
renders a reply box and sends `notification_reply` back to the phone, which
uses the existing `NotificationListenerService` to deliver it. Keep it opt-in
on both sides, matching the current notification mirror gates.

### B6. One-time location share — **M**
Phone sends current lat/lon (plus accuracy + timestamp) on demand; desktop
opens it in the browser via `parseAllowedUrl` (maps URL) or shows coordinates.
Adds `expo-location`, a `location_share` payload, a desktop button and
`isync location`. Make it explicitly one-shot, never continuous tracking.

---

## C. Power-user features from `Plan.md` (v1.0 goals)

### C1. Plugin / custom-command system — **L**
Plan.md v1.0 lists a plugin system. Define a small manifest (`name`,
`command`, `args`, `shell`, `timeoutMs`, `requiresOptIn`) under a new
`plugins/` workspace; desktop loads manifests, shows them as buttons in the
Commands tab and exposes `isync run <plugin>`. Reuse the existing
`run_pwsh`/`remote_command` executors and their allowlists — plugins only
reference named, pre-approved commands, never arbitrary code from the wire.

### C2. Interactive remote terminal — **L**
Plan.md phase 10 wanted SSH-over-WebSocket. Add `terminal_open` /
`terminal_data` / `terminal_close` payloads and a PTY bridge to InVx Termux
(allowlisted), with a small xterm.js panel in the desktop. Must be gated
separately from one-shot `remote_command` and never traverse the relay by
default.

### C3. Pairing with a short authentication string (SAS) — **M**
Plan.md phase 2 wanted a `123456` confirmation on both screens. Display a
6-digit code derived from the exchanged public keys and require a tap on both
devices before keys are pinned. This closes the last MITM gap in QR/paste
pairing. **Files:** `packages/protocol/src/pairing.ts`, desktop Connection tab,
mobile Connection screen, docs/protocol.md.

### C4. Resumable transfers, bandwidth caps and scheduling — **M/L**
`file_offer`/`file_chunk`/`file_abort` exist but a dropped transfer restarts
from zero. Add an offset/ACK to `file_chunk`, a resume token on `file_offer`,
plus settings for "LAN only for files" and an over-relay bandwidth cap. Keep
the 100 MiB soft cap and relay frame limits.

### C5. Clipboard rules / auto-actions — **M**
A small rule engine (regex → action) on the desktop: e.g. URLs from a domain
open immediately, text with a prefix goes to a specific peer, images above N
MiB are skipped. Add a Rules panel + `rules.json` in settings; evaluate in
`onClipboard` before `pushHistory`. Extends auto clipboard sync without
touching encryption.

---

## D. Quality, packaging and reach

### D1. Shipping: Windows installer + signed Android release — **M**
Plan.md v1.0 goals. Configure Tauri's NSIS/MSI bundle in
`apps/desktop/src-tauri/tauri.conf.json` and add `bun run desktop:installer`;
document EAS build/submit for the dev-client → production Android release using
`bunx eas-cli` (mobile AGENTS.md). Add checksum/publishing notes to README.

### D2. Localisation (English + German) — **M**
`Plan.md` is German while the UI is English-only. Extract strings from
`apps/desktop/src/App.tsx` and the mobile screens into locale files; add a
language setting to `DesktopSettings` / `appSettings.ts`. No protocol change.

### D3. Accessibility & keyboard navigation pass — **S/M**
Focus rings, ARIA labels and logical tab order in the desktop React UI, plus
screen-reader labels on the mobile manual tab bar (`TabBar.tsx`). Align with
`typeui-fundamentals` / `web-design-guidelines` checks.

### D4. Automated E2E verification of the loopback API — **M**
`control.rs` has no integration test; the CLI is exercised manually. Add a
test harness that boots the app (or a stub control server) and asserts every
`/v1/*` route from `isync`, including rejection paths (bad URL, disabled
PowerShell). Ties directly into the existing `bun test` workspace script.

### D5. Relay observability — **S/M**
Expose counters (frames forwarded, queued, rejected oversize, hello failures)
on the worker's `/health` endpoint in `workers/relay/src/index.ts`. Helps
diagnose "why did my clipboard not arrive" without decrypting anything.

---

## Priority matrix

| Order | Feature | Effort | Reuses | New protocol payload? |
| --- | --- | --- | --- | --- |
| 1 | A1 History search/pin | S | clipboardHistory stores | no |
| 2 | A3 RTT indicator | S | ping/pong | no |
| 3 | A4 `--json` + completions | S | control API | no |
| 4 | A5 Context menu + drop | S/M | `/v1/share`, `/v1/file` | no |
| 5 | B1 Device status | M | session fan-out | yes |
| 6 | C3 SAS pairing | M | pairing.ts | no (pair-time only) |
| 7 | A6 Vault biometric unlock | S/M | secretsStore | no |
| 8 | B2 TTS / B5 replies | M | remote_command / notification mirror | yes |
| 9 | C5 Clipboard rules | M | auto clipboard sync | no |
| 10 | C1 Plugin system | L | allowlisted executors | no |
| 11 | B4 Media control | L | invx-notify | yes |
| 12 | C2 Remote terminal | L | Termux bridge | yes |
| 13 | D1 Installer + release | M | Tauri / EAS | no |

## Suggested execution order

1. **Polish** (A1–A6): no wire changes, immediately testable, good first PRs.
2. **Telemetry & trust** (B1, C3): one new payload + pairing UX; update
   `docs/protocol.md` and `docs/architecture.md` in the same PR.
3. **Power user** (C1, C5, B2, B5): each behind its own opt-in setting.
4. **Big items** (C2, B4, C4): separate branches with their own verification.
5. **Ship** (D1–D5): bundle, localise, verify.

## Agent ownership when these are implemented

Per the project's toolchain, the work splits cleanly across specialists:

- **build / general implementer** — owns protocol payloads and shared code in
  `packages/protocol`, the Tauri commands in `src-tauri/src`, CLI changes in
  `apps/cli`, workers, and any new `plugins/` workspace. Runs `bun check`,
  `bun lint`, `bun fmt`, `bun test` after each slice.
- **frontend-specialist** — owns the desktop React UI (`App.tsx`, History /
  Connection / Commands / Send tabs, themes) and the mobile screens/components
  (`HomeScreen.tsx`, `SettingsScreen.tsx`, `TabBar.tsx`), including accessibility
  (D3) and mobile-first performance.
- **tester** — owns new unit/integration tests for each payload (mirroring
  `session.test.ts`, `relay.test.ts`, `adbDevices.test.ts`) and the loopback E2E
  harness (D4); verifies on `bun test` before any completion claim.
- **docs-specialist** — owns `docs/protocol.md`, `docs/architecture.md`,
  `README.md`, `Plan.md` roadmap updates and the Windows installer / EAS
  release notes (D1) once behaviour lands.
- **code-reviewer** — reviews every PR that touches crypto/pairing, relay
  limits, remote-command allowlists, SAF path handling or clipboard security;
  checks that opt-in gates and caps are preserved and that no plaintext/
  unsafe-scheme regression is introduced.

This document is a suggestions catalogue only — no implementation has been
started. Pick an item from the priority matrix to turn it into a work item.
