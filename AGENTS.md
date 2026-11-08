# involvex-sync — Agent Guide

End-to-end encrypted link, clipboard, file, and command sharing between **Android (Expo)** and **Windows (Tauri)**. Prefer LAN at home; fall back to a Cloudflare Durable Object relay or MyFritz when away.

## Repository layout

| Path                                                           | Role                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`packages/protocol`](packages/protocol)                       | Shared wire protocol: frames, Noble crypto, URL allowlist, loop guard                 |
| [`apps/desktop`](apps/desktop)                                 | Tauri 2 tray app (Windows) — LAN WebSocket listener, UI, loopback control API         |
| [`apps/mobile`](apps/mobile)                                   | Expo development build (Android) — share intent, notifications, IME/a11y integrations |
| [`apps/cli`](apps/cli)                                         | `isync` CLI — talks to the running desktop app over loopback                          |
| [`workers/relay`](workers/relay)                               | Hibernating Durable Object ciphertext mailbox (`sync.involvex.workers.dev`)           |
| [`workers/oauth-token-exchange`](workers/oauth-token-exchange) | OAuth redirect bridge + token exchange (`involvex-sync-oauth`)                        |
| [`docs/architecture.md`](docs/architecture.md)                 | Architecture, trust model, transport, platform constraints                            |
| [`docs/protocol.md`](docs/protocol.md)                         | Wire protocol, payload types, signing, URL allowlist                                  |

> Mobile-specific agent instructions live in [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md).

## Useful commands

Run from the repository root unless noted. This project uses **Bun workspaces** (`packageManager: bun@1.4.4`).

### Root (all workspaces)

```bash
bun install
bun run build        # build @involvex/protocol
bun test             # tests: @involvex/protocol + desktop services (gwsDrive)
bun check            # typecheck (Bun native) across protocol, desktop, mobile, cli, workers
bun lint             # Bun native linter
bun fmt              # Bun native formatter
bun run prebuild     # fmt + check + lint
```

### Desktop (Tauri + Vite)

```bash
bun run desktop:dev
bun run desktop:build
# or from apps/desktop:
cd apps/desktop && bun run tauri dev
cd apps/desktop && bun run check
```

Requires Rust and WebView2. The app listens on TCP **17391** (WebSocket) and exposes a loopback control API on **127.0.0.1:17392** for `isync`. Close/minimize hides to tray.

### CLI (`isync`)

With the desktop app running:

```bash
bun run isync -- status
bun run isync -- clipboard get
bun run isync -- clipboard set "hello from PC"
bun run isync -- clipboard push
bun run isync -- share https://example.com
bun run isync -- find
bun run isync -- show
bun run isync -- keyboard type "hello"
bun run isync -- keyboard key enter
# optional global shim: bun link --cwd apps/cli
```

### Mobile (Expo / Android)

Requires an **Expo development build** (not Expo Go). Use `bunx` for Expo tooling.

```bash
bun run mobile:start   # Metro (dev client)
bun run android        # debug install + Metro
bun run mobile:build   # release install, no Metro (--no-bundler)

cd apps/mobile
bunx expo prebuild --platform android
bun run check          # bun check + expo install --check
bun run build:apk      # APK only (needs android/ from prebuild)
```

Release APK output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

### Workers (Cloudflare / Wrangler)

```bash
bun run relay:dev
bun run relay:deploy
bun run oauth:dev
bun run oauth:deploy        # wrangler deploy --env-file .env -c wrangler.toml
bun run oauth:deploy:prod
```

## Technologies

- **Runtime & tooling:** Bun (workspaces, `bun check`, `bun lint`, `bun fmt`, `bun test`), TypeScript
- **Shared protocol:** `@involvex/protocol` (workspace) — Noble crypto (`@noble/ciphers`, `@noble/curves`, `@noble/hashes`)
- **Desktop:** Tauri 2, Vite, React 19, `@tauri-apps/plugin-*` (autostart, clipboard, notification, opener), `qrcode`
- **Mobile:** Expo SDK ~58, React Native 0.88, React 19, Expo Router/app config, `expo-camera`, `expo-notifications`, `expo-secure-store`, `expo-clipboard`, `expo-auth-session`, SAF/document picker, custom config plugins (e.g. cleartext traffic)
- **Workers:** Cloudflare Workers, Durable Objects (relay), Wrangler 4
- **Integrations:** `gws` (Google Workspace CLI) for desktop Drive uploads; Drive REST/OAuth on mobile; optional local `adb` for PC-side commands/screenshots

## Best practices & guidelines

### Security & protocol

- **E2E encryption is mandatory.** Pairing exchanges public keys in person (QR / Nearby Pair / Scan QR / pasted JSON). Frames are sealed with **X25519 + XChaCha20-Poly1305** and signed with **Ed25519**. The relay forwards opaque ciphertext only.
- **URL safety:** only `http:`/`https:` URLs without embedded credentials may be opened. Reject `file:`, `javascript:`, `intent:`, `data:` and similar unsafe schemes.
- **Remote commands are opt-in.** Phone→PC PowerShell, PC→phone Termux, and local ADB paths have explicit allow/settings gates. Respect caps and allowlists defined by the protocol/docs.
- **Clipboard/URL behavior:** clipboard sync applies to clipboard/history; do not auto-open URLs from clipboard sync. Use explicit share/send flows for browser-open behavior.

### Platform & product constraints

- **LAN vs away:** LAN pairing uses cleartext `ws://` on the local network (Android config supports this). Relay/MyFritz are for away-from-home, not a substitute for first-time LAN pairing.
- **Android 10+ clipboard limits:** background clipboard reads are restricted. Prefer Share intent; auto sync requires foreground or Sync Keyboard IME (as designed).
- **Mobile builds:** changes affecting native config/plugins (e.g. cleartext traffic, camera/permissions) require a native rebuild/dev client — Expo Go is not sufficient.
- **Desktop tray behavior:** minimize/close hides to tray; release/startup behavior is intentional (see `docs/architecture.md`).

### Development workflow

- **Use Bun** for installs and scripts; prefer `bunx` for Expo/EAS tooling in Bun projects.
- **Typecheck/lint/format** with repo scripts (`bun check`, `bun lint`, `bun fmt`). `bun check` runs Bun-native typechecking across workspaces (not `tsc --noEmit`).
- **Protocol changes** affect all clients/workers — update [`docs/protocol.md`](docs/protocol.md) and verify compatibility across `packages/protocol`, desktop, mobile, CLI, and relay.
- **Check paths/links** before publishing docs; keep command examples aligned with `package.json` scripts.

### Sources used

This guide was compiled from repository sources present in this workspace: [`README.md`](README.md), [`package.json`](package.json), [`bunfig.toml`](bunfig.toml), workspace `package.json` files, [`docs/architecture.md`](docs/architecture.md), [`docs/protocol.md`](docs/protocol.md), and [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md). No `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, or `Taskfile.yml` was found at the time of writing.
