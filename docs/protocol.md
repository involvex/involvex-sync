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
`termux_open_url`, `termux_clipboard_set`, `file_transfer`, `file_offer`,
`file_chunk`, `file_done`, `file_abort`, `notification_mirror`,
`keyboard_text`, `keyboard_key`, `keyboard_status`, `find_phone`,
`remote_command`, `remote_command_result`.

Chunked files: soft cap 100 MiB, ~64 KiB decoded chunks, `sha256` on
`file_done`. Legacy `file_transfer` remains for ≤2 MiB.

Clipboard images reuse `file_transfer` / `file_offer` with
`purpose: "clipboard"` (optional `hash` = sha256 of bytes). Prefer ≤1 MiB
after compress; hard abort above 2 MiB. Receivers apply to the OS clipboard
instead of saving to the incoming-files folder. Text stays on
`clipboard_update`.

Remote commands (`remote_command` / `remote_command_result`): `shell` is
`pwsh` (phone→PC), `termux` (PC→phone via InVx Termux), or `adb` (local on
PC only). Both sides require an explicit allow setting. Cap 2000 chars.

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

`from` is cleartext on purpose: with several paired devices the receiver picks
the decryption key by sender identity instead of guessing. `to` is optional;
when present it must equal the receiver's own device id or the frame is
dropped (a device in a full mesh can receive frames addressed elsewhere).

## URL allowlist

Only `http:` and `https:` without embedded credentials. `file:`, `javascript:`,
`intent:`, `data:` are rejected.
