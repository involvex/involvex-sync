# involvex Sync

End-to-end encrypted link sharing (and clipboard) between **Android (Expo)**
and **Windows (Tauri)**. Prefer LAN at home; fall back to a Cloudflare Durable
Object relay (or MyFritz) when away.

## Layout

| Path                                     | Role                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| [`packages/protocol`](packages/protocol) | Frames, Noble crypto, URL allowlist, loop guard       |
| [`apps/desktop`](apps/desktop)           | Tauri 2 tray app — LAN WebSocket listener             |
| [`apps/mobile`](apps/mobile)             | Expo development build — share intent + notifications |
| [`workers/relay`](workers/relay)         | Hibernating DO ciphertext mailbox                     |

## Quick start

```bash
bun install
bun test
bun check   # typecheck (Bun native, replaces tsc --noEmit)
bun lint    # Bun native linter
bun fmt     # Bun native formatter
```

### Desktop (Windows)

```bash
bun run desktop:dev
# or: cd apps/desktop && bun run tauri dev
```

Needs Rust + WebView2. The app listens on TCP **17391**, shows a pairing QR,
and opens http(s) URLs from the phone. Close/minimize hides to the **tray** —
left-click the tray icon (or `isync show`) if the window is missing.

### CLI (`isync`)

With the desktop app running:

```bash
bun run isync -- status
bun run isync -- clipboard get
bun run isync -- clipboard set "hello from PC"
bun run isync -- clipboard push          # OS clipboard → phone
bun run isync -- share https://example.com
bun run isync -- find
bun run isync -- show
bun run isync -- keyboard type "hello"
bun run isync -- keyboard key enter
```

Desktop **Screenshot** (Send / Commands): `adb exec-out screencap -p` → PC
clipboard image. Needs `adb` on PATH and an authorized device.

Install a global shim (optional): `bun link --cwd apps/cli` then `isync status`.

### Mobile (Android)

Requires a **development build** (not Expo Go):

```bash
# from repo root
bun run mobile:start     # Metro only
bun run android          # debug install + Metro
bun run mobile:build     # release install, no Metro (--no-bundler)

cd apps/mobile
bunx expo prebuild --platform android
bun run build:apk        # APK only (needs android/ from prebuild)
```

`mobile:build` uses `--no-bundler` so it does not steal a running Expo/Metro session.
Release APK: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

1. On the phone: **Nearby → Pair** (mDNS) or **Scan PC QR** (desktop Connection tab). Accept the pair banner on the PC (OS toast + window come forward).
2. After accept, status should read **Paired and connected**. Or paste desktop JSON under Advanced and tap **Connect**.
3. Share a link via Android Share → involvex Sync — the PC browser opens. Send / Find / Files / Sync Keyboard need a live WebSocket (status strip: Live).
4. On the phone, **Pick save folder** (Files card) so incoming files land on SD / Downloads via Android SAF — not private app storage.
5. Remote commands: phone **Run on PC** (PowerShell, opt-in on desktop); PC **Commands** tab for Termux (opt-in on phone) or local `adb shell`.
6. Away from home: mode `relay` (Cloudflare) or `myfritz` with your forwarded host — not for first-time LAN pair.

LAN pairing uses cleartext `ws://` (Android `usesCleartextTraffic`). Rebuild the Android
dev client after pulling cleartext / camera plugin changes.

### Relay

```bash
bun run relay:dev
# deploy: bun run relay:deploy
# custom domain: sync.involvex.workers.dev
```

The worker never decrypts. Free-plan limits apply (hibernation WebSockets,
small offline queue, no file transfer).

## Google Drive sync (desktop)

Opt-in: watch the same outbound sync folder and upload new/changed files with
[`gws`](https://github.com/googleworkspace/cli) (independent of PC → phone sync).

```bash
# install CLI (or download a release binary onto PATH)
npm install -g @googleworkspace/cli
gws auth login -s drive
gws drive files list --params '{"pageSize": 5}'
```

In the desktop **Files** tab: enable **Folder sync → Google Drive**, optional Drive
folder ID, then **Test gws connection**. Drop files into the sync folder; status
shows uploads.

**Phone:** Settings → paste a Google OAuth client ID (Drive API enabled; redirect
`involvex-sync://oauth`), then Files → **Connect Google Drive**. Upload / list /
download use the Drive REST API — not Termux/`gws`.

## Security notes

- Pairing exchanges public keys in person (QR / paste).
- Frames: X25519 + XChaCha20-Poly1305, Ed25519 signatures.
- Only `http`/`https` URLs without credentials are opened.
- Android 10+ blocks background clipboard reads — use Share for reliability.
- Opening the phone browser from Windows uses a notification (tap to open).

## Docs

- [docs/architecture.md](docs/architecture.md)
- [docs/protocol.md](docs/protocol.md)
