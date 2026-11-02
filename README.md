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
```

Install a global shim (optional): `bun link --cwd apps/cli` then `isync status`.

### Mobile (Android)

Requires a **development build** (not Expo Go):

```bash
cd apps/mobile
bunx expo prebuild --platform android
bun run android
```

1. Paste the desktop pairing JSON into the phone (or vice versa).
2. Enter the PC LAN IP (from the desktop UI) and **Connect** (mode `lan`).
3. Share a link via Android Share → involvex Sync — the PC browser opens.
4. Away from home: mode `relay` (Cloudflare) or `myfritz` with your forwarded host.

### Relay

```bash
bun run relay:dev
# deploy: bun run relay:deploy
# custom domain: sync.involvex.workers.dev
```

The worker never decrypts. Free-plan limits apply (hibernation WebSockets,
small offline queue, no file transfer).

## Security notes

- Pairing exchanges public keys in person (QR / paste).
- Frames: X25519 + XChaCha20-Poly1305, Ed25519 signatures.
- Only `http`/`https` URLs without credentials are opened.
- Android 10+ blocks background clipboard reads — use Share for reliability.
- Opening the phone browser from Windows uses a notification (tap to open).

## Docs

- [docs/architecture.md](docs/architecture.md)
- [docs/protocol.md](docs/protocol.md)
