# Wire protocol

Version: `1`

## Cleartext body (inside AEAD)

```json
{
  "v": 1,
  "id": "hex-random",
  "from": "deviceId",
  "to": "optional-peer-id",
  "ts": 1710000000000,
  "payload": { "type": "share_url", "url": "https://example.com" }
}
```

Payload types: `share_url`, `clipboard_update`, `ping`, `pong`, `pair_ack`,
`termux_open_url`, `termux_clipboard_set` (legacy — receive-only; prefer
`remote_command` + `shell: "termux"`), `file_transfer`, `file_offer`,
`file_chunk`, `file_done`, `file_abort`, `notification_mirror`,
`keyboard_text`, `keyboard_key`, `keyboard_status`, `find_phone`,
`remote_command`, `remote_command_result`, `adb_screencap_request`,
`note_upsert`, `note_delete`, `secret_upsert`, `secret_delete`,
`vault_key_share`, `clipboard_history_upsert`, `clipboard_history_delete`.

Chunked files: soft cap 100 MiB, ~64 KiB decoded chunks, `sha256` on
`file_done`. Legacy `file_transfer` remains for ≤2 MiB.

Optional `relativePath` on `file_offer` / `file_transfer` (e.g.
`notes/2026/a.pdf`): relative, forward slashes, no `..`, max 8 segments.
`name` stays the basename. Receivers recreate directories under the save
folder; peers that omit the field (or send an invalid path) save in the root.

Clipboard images reuse `file_transfer` / `file_offer` with
`purpose: "clipboard"` (optional `hash` = sha256 of bytes). Prefer ≤1 MiB
after compress; hard abort above 2 MiB. Receivers apply to the OS clipboard
instead of saving to the incoming-files folder. Text stays on
`clipboard_update`.

Shared text clipboard history (mesh fan-out + catch-up like notes):

- `clipboard_history_upsert` / `clipboard_history_delete` — text rows only
  (`MAX_CLIPBOARD_HISTORY` = 50, `MAX_CLIPBOARD_HISTORY_TEXT_CHARS` = 2000).
- Receiving a history row must **not** write the OS clipboard; History UI
  Copy / resend (or `isync clipboard resend`) does that.
- Image history entries stay local (filesystem path / URI) and never travel
  on this path. Live `clipboard_update` remains the current clip only.
- Client-side search, pin/favourites, and retention settings must not appear
  on the wire — keep the upsert payload to `id` / `text` / `updatedAt` only.

Legacy Termux payloads: `termux_open_url` and `termux_clipboard_set` remain
in the union so old peers do not crash, but nothing sends them. PC→phone
automation uses `remote_command` with `shell: "termux"`.

Remote commands (`remote_command` / `remote_command_result`): `shell` is
`pwsh` (phone→PC), `termux` (PC→phone via InVx Termux), or `adb`.
**`shell: "adb"` is never executed from an inbound wire frame** — local ADB
shell/screencap on the desktop is opt-in UI / Tauri only. Both `pwsh` and
`termux` require an explicit allow setting. Cap 2000 chars.

`adb_screencap_request`: phone → PC asks for a local `adb screencap`. Desktop
honours it only when Settings → “Allow phone to request ADB screenshot” is on
and a usable ADB device is present; the reply is a clipboard-purpose image
transfer (≤2 MiB), not a video stream. Independent of Sync Live vs relay —
ADB is a parallel local trust boundary.

Notes / secrets (synced across every connected host):

- `note_upsert` / `note_delete` — plain title/body with soft caps
  (`MAX_NOTES`, `MAX_NOTE_*`).
- `secret_upsert` / `secret_delete` — vault-AEAD ciphertext + label/kind meta.
- `vault_key_share` — one-time 32-byte vault key bootstrap (transport-sealed).

`keyboard_status`: `{ active, mode? }` where `mode` is `ime` | `a11y` |
`none`. Older clients may omit `mode`; treat `active` alone as IME-ready.

## Signed envelope

```json
{
  "v": 1,
  "from": "deviceId",
  "nonce": "hex-24-bytes",
  "ciphertext": "hex",
  "signature": "hex-ed25519"
}
```

Signature input UTF-8: `v{version}|{from}|{nonce}|{ciphertext}`.

## Relay hello (cleartext, worker-verified)

Before the Durable Object admits a socket to a pair room (or replaces an
existing one / flushes the offline queue), the client sends:

```json
{
  "kind": "involvex-sync-relay-hello",
  "deviceId": "…",
  "roomId": "sorted-A:B",
  "ed25519PublicKey": "hex",
  "nonce": "hex",
  "ts": 1710000000000,
  "signature": "hex-ed25519"
}
```

Sign input UTF-8:
`involvex-sync-relay-hello|{deviceId}|{roomId}|{ed25519PublicKey}|{nonce}|{ts}`.
The worker pins the first verified public key per device id. Live forward
cap ≈ 256 KiB; offline queue only stores frames ≤ 8 KiB.

`from` is cleartext on purpose: with several paired devices the receiver picks
the decryption key by sender identity instead of guessing. `to` is optional;
when present it must equal the receiver's own device id or the frame is
dropped (a device in a full mesh can receive frames addressed elsewhere).

## URL allowlist

Only `http:` and `https:` without embedded credentials. `file:`, `javascript:`,
`intent:`, `data:` are rejected.
