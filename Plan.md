Das Projekt könnte deutlich mehr werden als ein KDE-Connect-Klon.

Wenn du es richtig aufziehst, könnte involvex Sync eine Mischung aus:

KDE Connect
Phone Link
AirDrop
Pushbullet
Termux Remote Control

werden.

Vision
┌─────────────────────┐
│ Android App │
│ Expo App │
└──────────┬──────────┘
│
▼
┌─────────────────────┐
│ Native Android SDK │
│ Clipboard Manager │
│ Share API │
│ Foreground Service │
│ mDNS Discovery │
└──────────┬──────────┘
│
▼
═════════════════════════
End-to-End Encryption
═════════════════════════
│
▼
┌─────────────────────┐
│ Tauri App │
│ Windows │
└──────────┬──────────┘
│
▼
┌─────────────────────┐
│ Native Windows APIs │
│ Clipboard │
│ Browser Launch │
│ Notifications │
│ Filesystem │
└─────────────────────┘

OPTIONAL

┌─────────────────────┐
│ Termux │
└──────────┬──────────┘
▼
termux-open-url
termux-clipboard
termux-share
custom scripts
bun run ...

Projektstruktur
invx-connect/
│
├─ apps/
│ ├─ mobile/
│ │ Expo
│ │
│ └─ desktop/
│ Tauri
│
├─ packages/
│ ├─ protocol/
│ ├─ crypto/
│ ├─ websocket/
│ ├─ shared-types/
│ └─ mdns/
│
└─ server/

Monorepo mit:

bun

oder

pnpm

Phase 1
Geräte finden
Discovery

mDNS

wie KDE Connect

Android startet:

_invxconnect._tcp.local

Windows sucht:

_invxconnect._tcp.local

Beispiel:

{
"name":"Pixel8",
"type":"android",
"port":17391
}

Technologien

Android

NsdManager

Windows

mdns-sd

oder

zeroconf

Phase 2
Pairing

Bei erstem Kontakt

123456

erscheint auf beiden Geräten

Trust Device?

Dann:

ED25519 Keypair

generieren

Speichern

Android:

EncryptedSharedPreferences

Windows:

Windows Credential Manager

Phase 3
Transport Layer

Direkte Kommunikation

WebSocket TLS

Android
↕
Windows

Message Schema

{
"type":"clipboard",
"payload":"hello"
}

{
"type":"open_url",
"payload":"https://github.com"
}

{
"type":"file"
}

Phase 4
Encryption

Libsodium

X25519

für Key Exchange

ChaCha20-Poly1305

für Nachrichten

Jede Nachricht:

{
"nonce":"",
"ciphertext":"",
"signature":""
}

Phase 5
Clipboard Sync

Android

Native Modul

ClipboardManager

Listener

addPrimaryClipChangedListener()

Wenn Änderung

{
"type":"clipboard_update",
"text":"copied text"
}

Windows

Tauri Plugin

tauri-plugin-clipboard-manager

Sync Ablauf

Android Copy
↓
WebSocket
↓
Windows Update Clipboard

oder

Windows Copy
↓
Android Update Clipboard

Loop Protection

Damit kein Endlos-Loop entsteht:

{
"source":"android"
}

Phase 6
URL Sharing

Android Share Menü

Teilen →
involvex Sync →
Windows

Nachricht

{
"type":"share_url",
"url":"https://github.com"
}

Windows

open::that(url)

Resultat

Link auf Android senden
↓
Browser öffnet sofort auf Windows

Und umgekehrt

Windows Kontextmenü

Send To Phone

Android

Intent.ACTION_VIEW

Phase 7
Dateiübertragung

File Message

{
"type":"file_begin"
}

Transfer

Chunk 1
Chunk 2
Chunk 3
...

Für große Dateien

64 KB Chunks

Fortschritt

37%
85%
100%

Phase 8
Notifications

Android

Notification Listener

NotificationListenerService

Windows

tauri-plugin-notification

z.B.

Discord Message
WhatsApp Message
Signal Message

als Mirror.

Phase 9
Execute in Termux

Das wird dein Alleinstellungsmerkmal.

Architektur

involvex Sync
↓
Termux Bridge
↓
termux-api

Nachricht

{
"type":"termux_command",
"command":"clipboard"
}

Android führt aus

termux-clipboard-get

Antwort

{
"clipboard":"hello world"
}

Unterstützte Commands
URL öffnen
termux-open-url

Clipboard lesen
termux-clipboard-get

Clipboard schreiben
termux-clipboard-set

Share
termux-share

Notification
termux-notification

TTS
termux-tts-speak

Kamera
termux-camera-photo

Taschenlampe
termux-torch on

Shell
bun run deploy.ts

oder

python backup.py

direkt vom Windows-PC auf dem Smartphone auslösen.

Phase 10
Power User Features

Später:

Remote Terminal
Windows
↓
SSH-over-WebSocket
↓
Termux

Sync Clipboard History
Ctrl+C Historie

ähnlich Ditto.

Send Command To Phone
Run Bun Script
Run Git Pull
Restart Service

QR Pairing

wie KDE Connect

Scan QR
→ Pair

Roadmap MVP
v0.1
Gerät finden (mDNS)
Pairing
Clipboard Sync
URL Sharing
v0.2
Dateien senden
Notifications
QR Pairing
v0.3
Execute in Termux
Clipboard History
Multi Device
v1.0
End-to-End Encryption
Remote Commands
Plugin System
Windows Installer
Android Release

Wenn du Bun ohnehin bevorzugst, würde ich den gesamten Stack auf Bun + TypeScript + Expo + Tauri 2 + libsodium aufbauen. Das passt sehr gut zu deinem bestehenden Open-Source-Portfolio und hält fast die gesamte Business-Logik in gemeinsam nutzbaren TypeScript-Packages. Dadurch musst du nur Discovery, Clipboard und OS-spezifische Features nativ implementieren.

involvex-Sync/
│
├── apps/
│ │
│ ├── mobile/
│ │ ├── app/
│ │ ├── src/
│ │ │
│ │ ├── screens/
│ │ │ ├── Devices.tsx
│ │ │ ├── Pairing.tsx
│ │ │ ├── Clipboard.tsx
│ │ │ └── Settings.tsx
│ │ │
│ │ ├── store/
│ │ │ ├── devices.ts
│ │ │ └── clipboard.ts
│ │ │
│ │ ├── services/
│ │ │ ├── websocket.ts
│ │ │ ├── pairing.ts
│ │ │ ├── mdns.ts
│ │ │ └── crypto.ts
│ │ │
│ │ └── native/
│ │ ├── ClipboardModule.ts
│ │ ├── ShareModule.ts
│ │ └── DeviceModule.ts
│ │
│ └── desktop/
│ │
│ ├── src/
│ │ ├── pages/
│ │ ├── components/
│ │ ├── store/
│ │ └── services/
│ │
│ └── src-tauri/
│ │
│ ├── src/
│ │ ├── main.rs
│ │ ├── clipboard.rs
│ │ ├── pairing.rs
│ │ ├── websocket.rs
│ │ ├── crypto.rs
│ │ ├── file_transfer.rs
│ │ └── notifications.rs
│ │
│ └── icons/
│
├── packages/
│ │
│ ├── shared-types/
│ │ ├── messages.ts
│ │ ├── device.ts
│ │ └── protocol.ts
│ │
│ ├── crypto/
│ │ ├── sodium.ts
│ │ ├── encryption.ts
│ │ └── signatures.ts
│ │
│ ├── protocol/
│ │ ├── clipboard.ts
│ │ ├── files.ts
│ │ ├── pairing.ts
│ │ ├── url.ts
│ │ └── notifications.ts
│ │
│ ├── websocket/
│ │ ├── client.ts
│ │ ├── server.ts
│ │ └── events.ts
│ │
│ └── mdns/
│ ├── discovery.ts
│ └── advertise.ts
│
├── plugins/
│ │
│ └── termux/
│ ├── commands.ts
│ ├── clipboard.ts
│ ├── open-url.ts
│ └── share.ts
│
├── docs/
│ ├── protocol.md
│ ├── pairing.md
│ └── architecture.md
│
├── scripts/
│ ├── build-mobile.ts
│ ├── build-desktop.ts
│ └── release.ts
│
├── package.json
├── bun.lock
├── bunfig.toml
└── tsconfig.json

involvex Sync
involvex Sync Desktop
involvex Sync Mobile

Domain:
sync.involvex.workers.dev
github.com/involvex/involvex-sync
